"""ICS 현재 스프린트 이슈 → aletheia localhost:3000 스케줄 추가.

사용법:
  uv run python sync_sprint_to_aletheia.py
  uv run python sync_sprint_to_aletheia.py --dry-run   # POST 없이 확인만
  uv run python sync_sprint_to_aletheia.py --category-id 2
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

import requests
from playwright.sync_api import sync_playwright

from ics_session import ensure_session, BASE_URL, SSO_ID

ALETHEIA_BASE = "http://localhost:3000/api"
BOARD_ID = 1582  # LGAP 칸반보드


def map_status(ics_status: str) -> str:
    """ICS 이슈 상태 → aletheia 스케줄 status 매핑."""
    s = ics_status.strip().lower()
    if s in ("done", "완료", "resolved", "closed"):
        return "done"
    if s in ("in progress", "진행 중", "진행중"):
        return "in_progress"
    if s in ("to do", "할 일", "open", "new"):
        return "not_started"
    return "pending"


def _iso_to_date(iso: str | None) -> str | None:
    """'2026-05-07T08:30:00.000+09:00' → '2026-05-07'. None → None."""
    if not iso:
        return None
    return iso[:10]


def crawl_sprint_issues(headless: bool = True) -> tuple[list[dict], str, str]:
    """Jira Agile REST API로 현재 활성 스프린트 이슈만 수집.

    Returns:
        (issues, sprint_start, sprint_end)  — 날짜는 'YYYY-MM-DD'
    """
    print("=" * 60)
    print("1. ICS 세션 연결...")
    issues_all: list[dict] = []
    sprint_start = sprint_end = datetime.now().strftime("%Y-%m-%d")

    with sync_playwright() as p:
        ctx = ensure_session(p, headless=headless)
        page = ctx.new_page()

        # same-origin 보장을 위해 칸반보드 페이지 먼저 로드
        kanban_url = f"{BASE_URL}/secure/RapidBoard.jspa?projectKey=LGAP&rapidView={BOARD_ID}"
        print(f"2. 칸반보드 페이지 로드: {kanban_url}")
        page.goto(kanban_url, wait_until="networkidle")

        # ── 활성 스프린트 조회 ────────────────────────────────────────
        print("3. 활성 스프린트 조회...")
        sprint_resp = page.evaluate(f"""
            async () => {{
                const r = await fetch('{BASE_URL}/rest/agile/1.0/board/{BOARD_ID}/sprint?state=active',
                    {{credentials: 'include'}});
                return r.ok ? await r.json() : {{error: r.status}};
            }}
        """)

        if not sprint_resp or not sprint_resp.get("values"):
            print(f"   ❌ 활성 스프린트 없음: {sprint_resp}")
            ctx.close()
            return [], sprint_start, sprint_end

        sprint = sprint_resp["values"][0]
        sprint_id = sprint["id"]
        sprint_name = sprint.get("name", "unknown")
        sprint_start = _iso_to_date(sprint.get("startDate")) or sprint_start
        sprint_end = _iso_to_date(sprint.get("endDate")) or sprint_end
        print(f"   스프린트: {sprint_name} (ID={sprint_id})")
        print(f"   기간: {sprint_start} ~ {sprint_end}")

        # ── 스프린트 이슈 조회 ───────────────────────────────────────
        print("4. 스프린트 이슈 조회...")
        issues_url = (
            f"{BASE_URL}/rest/agile/1.0/sprint/{sprint_id}/issue"
            "?maxResults=200&fields=summary,status,assignee,duedate"
        )
        issues_resp = page.evaluate(f"""
            async () => {{
                const r = await fetch('{issues_url}', {{credentials: 'include'}});
                return r.ok ? await r.json() : {{error: r.status}};
            }}
        """)

        if not issues_resp or issues_resp.get("error"):
            print(f"   ❌ 이슈 조회 실패: {issues_resp}")
            ctx.close()
            return [], sprint_start, sprint_end

        raw_issues = issues_resp.get("issues", [])
        print(f"   총 {len(raw_issues)}건 수집")

        for item in raw_issues:
            fields = item.get("fields", {})
            assignee = fields.get("assignee") or {}
            issues_all.append({
                "이슈키": item["key"],
                "제목": fields.get("summary", ""),
                "상태": fields.get("status", {}).get("name", ""),
                "담당자_이름": assignee.get("displayName", ""),
                "담당자_id": assignee.get("name", ""),
                "링크": f"{BASE_URL}/browse/{item['key']}",
                "duedate": fields.get("duedate"),  # 이슈별 마감일 (YYYY-MM-DD or None)
            })

        ctx.close()

    return issues_all, sprint_start, sprint_end


def get_existing_schedules(category_id: int) -> set[str]:
    """이미 등록된 스케줄 제목 집합 반환 (중복 방지)."""
    r = requests.get(f"{ALETHEIA_BASE}/schedules", params={"category_id": category_id}, timeout=10)
    r.raise_for_status()
    return {s["title"] for s in r.json()}


def post_schedule(
    category_id: int,
    issue: dict,
    sprint_start: str,
    sprint_end: str,
    dry_run: bool,
) -> dict | None:
    """이슈 하나를 aletheia 스케줄로 등록."""
    title = f"[{issue['이슈키']}] {issue['제목']}"
    description = f"담당자: {issue['담당자_이름']}\n링크: {issue['링크']}"
    status = map_status(issue["상태"])

    planned_start = sprint_start
    # duedate가 있으면 planned_end 로, 없으면 스프린트 종료일
    planned_end = issue["duedate"] or sprint_end
    # planned_end 가 스프린트 시작보다 이전인 경우(과거 due) → 스프린트 종료일로 보정
    if planned_end < planned_start:
        planned_end = sprint_end

    payload = {
        "category_id": category_id,
        "title": title,
        "description": description,
        "planned_start": planned_start,
        "planned_end": planned_end,
        "status": status,
    }

    if dry_run:
        print(f"  [DRY-RUN] {issue['이슈키']:12s} {planned_start}~{planned_end}  {status:12s}  {issue['제목'][:50]}")
        return payload

    r = requests.post(f"{ALETHEIA_BASE}/schedules", json=payload, timeout=10)
    if r.ok:
        new_id = r.json().get("id") or "?"
        print(f"  ✓ id={new_id!s:4s}  {issue['이슈키']:12s} {planned_start}~{planned_end}  {status:12s}  {issue['제목'][:45]}")
        return r.json()
    else:
        print(f"  ✗ 실패 ({r.status_code}): {r.text[:200]}")
        return None


def main():
    parser = argparse.ArgumentParser(description="ICS 스프린트 → aletheia 스케줄 동기화")
    parser.add_argument("--category-id", type=int, default=2, help="aletheia 카테고리 ID (기본: 2=API)")
    parser.add_argument("--dry-run", action="store_true", help="실제 등록 없이 확인만")
    parser.add_argument("--headed", action="store_true", help="브라우저 GUI 표시")
    parser.add_argument("--user", default=SSO_ID, help="특정 사용자 이슈만 필터 (기본: .env ICS_ID). 'all'이면 전체")
    parser.add_argument("--title-filter", default="", help="제목에 이 문자열이 포함된 이슈만 필터")
    args = parser.parse_args()

    title_filter_display = args.title_filter or "(없음)"
    print(f"\n대상 카테고리 ID: {args.category_id}")
    print(f"사용자 필터: {args.user}")
    print(f"제목 필터: {title_filter_display}")
    print(f"모드: {'DRY-RUN' if args.dry_run else 'LIVE'}\n")

    # 1. 현재 스프린트 이슈 크롤링 (REST API 기반)
    issues, sprint_start, sprint_end = crawl_sprint_issues(headless=not args.headed)
    print(f"\n스프린트 기간: {sprint_start} ~ {sprint_end}")

    if not issues:
        print("❌ 이슈를 수집하지 못했습니다. 종료.")
        sys.exit(1)

    # 2. 사용자 필터
    if args.user and args.user != "all":
        issues = [i for i in issues if args.user in i.get("담당자_id", "")]
        print(f"사용자 필터 적용: {len(issues)}건")

    # 3. 제목 필터
    if args.title_filter:
        kw = args.title_filter.lower()
        issues = [i for i in issues if kw in i["제목"].lower() or kw in i["이슈키"].lower()]
        print(f"제목 필터 적용: {len(issues)}건")

    print(f"\n최종 수집 이슈: {len(issues)}건")

    if not issues:
        print("❌ 필터 후 이슈가 없습니다. 종료.")
        sys.exit(1)

    # 4. 기존 스케줄 확인 (중복 방지)
    existing = set()
    if not args.dry_run:
        try:
            existing = get_existing_schedules(args.category_id)
            print(f"기존 스케줄: {len(existing)}건")
        except Exception as e:
            print(f"⚠️  기존 스케줄 조회 실패: {e}")

    # 5. 스케줄 등록
    print(f"\n{'이슈키':12s} {'기간':23s} {'상태':12s} 제목")
    print("-" * 80)
    added, skipped = 0, 0
    for issue in issues:
        title = f"[{issue['이슈키']}] {issue['제목']}"
        if title in existing:
            print(f"  - 스킵 (이미 존재): {title[:60]}")
            skipped += 1
            continue
        result = post_schedule(args.category_id, issue, sprint_start, sprint_end, args.dry_run)
        if result:
            added += 1

    print(f"\n완료: 추가 {added}건, 스킵 {skipped}건")


if __name__ == "__main__":
    main()
