"""현재 스프린트 + 이전 스프린트 전체 Camera 관련 티켓 통계 조회.

- 스프린트별 Camera 티켓 수 / Done 수 / Carry-over 수 / 진행률
- Carry-over 판별: 연속한 두 스프린트에 동일한 티켓 KEY(예: LGAP-323) 또는
  동일한 티켓 제목(summary)이 존재하는 경우

사용법:
  uv run python query_camera_sprint.py
  uv run python query_camera_sprint.py --keyword Camera
  uv run python query_camera_sprint.py --limit 5
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

from ics_session import BASE_URL, ensure_session

BOARD_ID = 1582


def fetch_sprint_issues(page, sprint_id: int) -> list[dict]:
    fields = "summary,status,labels,components"
    url = (
        f"{BASE_URL}/rest/agile/1.0/sprint/{sprint_id}/issue"
        f"?maxResults=500&fields={fields}"
    )
    resp = page.evaluate(f"""
        async () => {{
            const r = await fetch('{url}', {{credentials: 'include'}});
            return r.ok ? await r.json() : {{error: r.status}};
        }}
    """)
    if not resp or resp.get("error"):
        return []
    return resp.get("issues", [])


def is_camera(issue: dict, keyword: str) -> bool:
    f = issue.get("fields", {})
    kw = keyword.lower()
    summary = (f.get("summary") or "").lower()
    labels = [l.lower() for l in (f.get("labels") or [])]
    components = [c.get("name", "").lower() for c in (f.get("components") or [])]
    return (kw in summary
            or any(kw in l for l in labels)
            or any(kw in c for c in components))


def is_done(issue: dict) -> bool:
    status = (issue.get("fields", {}).get("status") or {}).get("name", "").lower()
    return status in ("done", "완료", "resolved", "closed")


def run(keyword: str, limit: int | None):
    with sync_playwright() as p:
        ctx = ensure_session(p, headless=True)
        page = ctx.new_page()

        kanban_url = f"{BASE_URL}/secure/RapidBoard.jspa?projectKey=LGAP&rapidView={BOARD_ID}"
        print("칸반보드 로드 중...")
        page.goto(kanban_url, wait_until="networkidle")

        print("스프린트 목록 조회 중...")
        all_sprints: list[dict] = []
        start_at = 0
        while True:
            resp = page.evaluate(f"""
                async () => {{
                    const r = await fetch(
                        '{BASE_URL}/rest/agile/1.0/board/{BOARD_ID}/sprint?state=active,closed&startAt={start_at}&maxResults=50',
                        {{credentials: 'include'}}
                    );
                    return r.ok ? await r.json() : {{error: r.status}};
                }}
            """)
            if not resp or resp.get("error"):
                print(f"  스프린트 목록 조회 실패: {resp}")
                break
            values = resp.get("values", [])
            all_sprints.extend(values)
            if resp.get("isLast", True) or not values:
                break
            start_at += len(values)

        all_sprints.sort(key=lambda s: s.get("startDate") or "")
        print(f"총 {len(all_sprints)}개 스프린트 발견")

        if limit:
            all_sprints = all_sprints[-limit:]
            print(f"최근 {limit}개 스프린트만 조회")

        sprint_data: list[dict] = []
        # 이전 스프린트 카메라 티켓: key set + summary set
        prev_cam_keys: set[str] = set()
        prev_cam_summaries: set[str] = set()

        for i, sprint in enumerate(all_sprints):
            sid = sprint["id"]
            sname = sprint.get("name", f"Sprint-{sid}")
            sstart = (sprint.get("startDate") or "?")[:10]
            send = (sprint.get("endDate") or "?")[:10]
            state = sprint.get("state", "?")

            print(f"  [{i+1}/{len(all_sprints)}] {sname} ({sstart}~{send})", flush=True)

            issues = fetch_sprint_issues(page, sid)
            cam_issues = [iss for iss in issues if is_camera(iss, keyword)]

            done_count = sum(1 for iss in cam_issues if is_done(iss))

            # Carry-over 판별: 같은 KEY 또는 같은 summary가 직전 스프린트에 있으면
            carryover_keys: set[str] = set()
            carryover_details: list[dict] = []
            for iss in cam_issues:
                key = iss["key"]
                summary_norm = iss["fields"]["summary"].strip().lower()
                reason = None
                if key in prev_cam_keys:
                    reason = f"KEY 일치: {key}"
                elif summary_norm in prev_cam_summaries:
                    reason = f"제목 일치: {iss['fields']['summary'][:50]}"
                if reason:
                    carryover_keys.add(key)
                    carryover_details.append({"key": key, "reason": reason,
                                              "summary": iss["fields"]["summary"]})

            sprint_data.append({
                "sprint_id": sid,
                "sprint_name": sname,
                "start": sstart,
                "end": send,
                "state": state,
                "total_issues": len(issues),
                "camera_total": len(cam_issues),
                "camera_done": done_count,
                "camera_carryover": len(carryover_keys),
                "carryover_details": carryover_details,
                "camera_issues": [
                    {
                        "key": iss["key"],
                        "summary": iss["fields"]["summary"],
                        "status": (iss["fields"].get("status") or {}).get("name", "?"),
                        "carryover": iss["key"] in carryover_keys,
                    }
                    for iss in cam_issues
                ],
            })

            # 다음 스프린트 비교를 위해 이번 스프린트 카메라 티켓 저장
            prev_cam_keys = {iss["key"] for iss in cam_issues}
            prev_cam_summaries = {iss["fields"]["summary"].strip().lower() for iss in cam_issues}

        ctx.close()

    sep = "=" * 90
    print(f"\n{sep}")
    print(f"  키워드: '{keyword}'  |  조회 스프린트: {len(sprint_data)}개")
    print(sep)
    print(f"{'스프린트':<36} {'기간':<22} {'전체':>5} {'Cam':>5} {'Done':>5} {'Carry':>6} {'진행률':>8}")
    print("-" * 90)
    for d in sprint_data:
        mark = "▶" if d["state"] == "active" else " "
        pct = f"{d['camera_done']/d['camera_total']*100:.0f}%" if d["camera_total"] else "-"
        print(f"{mark}{d['sprint_name']:<35} {d['start']}~{d['end']}  "
              f"{d['total_issues']:>5} {d['camera_total']:>5} {d['camera_done']:>5} {d['camera_carryover']:>6} {pct:>8}")
    print(sep)

    print("\n[스프린트별 Camera 티켓 상세]")
    for d in sprint_data:
        if not d["camera_issues"]:
            continue
        am = " ▶(active)" if d["state"] == "active" else ""
        pct = f"{d['camera_done']/d['camera_total']*100:.0f}%" if d["camera_total"] else "-"
        print(f"\n■ {d['sprint_name']}{am}")
        print(f"  Camera:{d['camera_total']}건  Done:{d['camera_done']}건  진행률:{pct}  Carry-over:{d['camera_carryover']}건")
        for iss in d["camera_issues"]:
            co = " ★Carry" if iss["carryover"] else ""
            print(f"  {iss['key']:<12} [{iss['status']:<14}]{co}  {iss['summary'][:55]}")
        if d["carryover_details"]:
            print(f"  [Carry-over 근거]")
            for cd in d["carryover_details"]:
                print(f"    {cd['key']}: {cd['reason']}")

    out = Path(__file__).parent / "debug" / "camera_all_sprints.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"keyword": keyword, "sprints": sprint_data},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n결과 저장: {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", default="camera")
    parser.add_argument("--limit", type=int, default=None,
                        help="최근 N개 스프린트만 (기본: 전체)")
    args = parser.parse_args()
    run(args.keyword, args.limit)
