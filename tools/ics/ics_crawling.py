"""ICS 크롤링 함수 모음 (Playwright 기반).

로그인/세션은 ics_session.ensure_session() 에서 처리.
이 모듈은 인증된 Page 를 받아 데이터를 추출한다.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta
from pathlib import Path

from bs4 import BeautifulSoup
from playwright.sync_api import Page, sync_playwright

from ics_session import BASE_URL, ensure_session

# ---------------------------------------------------------------------------
# 디버그 유틸
# ---------------------------------------------------------------------------
DEBUG_DIR = Path(__file__).parent / "debug"


def _dbg(page_or_frame, label: str) -> None:
    """실패 지점의 스크린샷 + HTML 을 debug/ 폴더에 저장하고 URL 을 출력한다."""
    DEBUG_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%H%M%S")
    slug = f"{ts}_{label}"
    try:
        url = getattr(page_or_frame, "url", "(frame — no url)")
        print(f"   [DBG] URL: {url}")
    except Exception:
        pass
    try:
        page_or_frame.screenshot(path=str(DEBUG_DIR / f"{slug}.png"), full_page=True)
        print(f"   [DBG] 스크린샷 → debug/{slug}.png")
    except Exception as e:
        print(f"   [DBG] 스크린샷 실패: {e}")
    try:
        html = page_or_frame.content()
        (DEBUG_DIR / f"{slug}.html").write_text(html, encoding="utf-8")
        print(f"   [DBG] HTML → debug/{slug}.html")
    except Exception as e:
        print(f"   [DBG] HTML 저장 실패: {e}")

# ---------------------------------------------------------------------------
# 설정 상수
# ---------------------------------------------------------------------------
SPRINT02_START = datetime(2026, 3, 23)

# .env ICS_ID 를 포함한 팀원 목록 — 필요에 따라 수정하세요
_ICS_ID = os.getenv("ICS_ID", "")
TARGET_USERS1 = list(filter(None, [
    _ICS_ID, "shkim4480", "heon1206", "taejoong.kim", "schjeong", "sunghyun.lim",
]))
TARGET_USERS2 = [
    "ldh1205", "krishna.deepika", "jusungha", "bluesky0327", "sungwoo1.han",
    "mkhong", "hyuntai.chin", "janghyeon.baek", "lsj931228", "sunghyun.lim",
]
WATCH_USERS = [
    "akshatg", "anderson", "atif.sarwari", "ben.schmidt",
    "christopher.ortiz", "gaurav", "jamesoneill",
    "sungwoo.kim", "vignesh.sethuraman", "jiho", "kevink", "dan.tapia",
]
WATCH_USERS_LOWER = [u.lower() for u in WATCH_USERS]


# ---------------------------------------------------------------------------
# 스프린트 이름
# ---------------------------------------------------------------------------
def get_current_sprint_name() -> str:
    """현재 날짜 기준 활성 스프린트 필터명 반환."""
    # [임시] 필터명 하드코딩 — ICS 실제 필터명 기준으로 교체 필요
    name = "Filter for Phase2_Scrum"
    print(f"   [임시] 필터명 하드코딩: {name}")
    return name

    # [원래 로직] Sprint01은 3/03~3/20, Sprint02(3/23)부터 2주(14일) 간격
    # today = datetime.now()
    # if today < SPRINT02_START:
    #     sprint_num = 1
    # else:
    #     sprint_num = 2 + (today - SPRINT02_START).days // 14
    # return f"Filter for Phase2_Sprint{sprint_num:02d}"


# ---------------------------------------------------------------------------
# 단일 단위별 보고서 크롤링
# ---------------------------------------------------------------------------
def navigate_to_report(page: Page, sprint_name: str) -> str | None:
    """단일 단위별 보고서를 크롤링하여 HTML 반환.

    Args:
        page: 인증된 Playwright Page 객체
        sprint_name: ICS 필터명 (예: "Filter for Phase2_Scrum")

    Returns:
        보고서 페이지 HTML 문자열, 실패 시 None
    """
    report_url = (
        f"{BASE_URL}/secure/ConfigureReport!default.jspa"
        "?selectedProjectId=12302"
        "&projectOrFilterId=project-12302"
        "&projectOrFilterName=LGIT%20and%20Applied%20Intuition"
        "&reportKey=com.atlassian.jira.jira-core-reports-plugin:singlelevelgroupby"
    )
    print("\n4. 보고서 페이지 접속...")
    page.goto(report_url)
    page.wait_for_load_state("networkidle")
    print(f"   도착 URL: {page.url}")

    # 5. 필터 선택 팝업 열기
    print("5. 필터 선택 팝업 열기...")
    try:
        page.locator("#filter_filterid_button").wait_for(timeout=10_000)
    except Exception as e:
        print(f"   ❌ #filter_filterid_button 을 찾지 못함: {e}")
        # 페이지에 존재하는 버튼/링크 목록 출력
        btns = page.locator("input[type=button], button, a").all()
        print(f"   [DBG] 페이지 내 버튼/링크 ({len(btns)}개):")
        for b in btns[:20]:
            print(f"        id={b.get_attribute('id')!r:30s} text={b.inner_text()[:40]!r}")
        _dbg(page, "step5_no_filter_btn")
        return None

    try:
        with page.expect_popup(timeout=15_000) as popup_info:
            page.locator("#filter_filterid_button").click()
        popup = popup_info.value
        popup.wait_for_load_state("networkidle")
    except Exception as e:
        print(f"   ❌ 팝업이 열리지 않음: {e}")
        _dbg(page, "step5_popup_failed")
        return None

    # 팝업이 로그인 페이지로 리다이렉트됐는지 확인 (세션 만료 감지)
    if "login" in popup.url.lower():
        print(f"   ❌ 세션 만료 — 팝업이 로그인 페이지로 리다이렉트됨: {popup.url}")
        print("   → auth/state.json 을 삭제하고 다시 실행하면 재로그인됩니다:")
        print("      PowerShell: Remove-Item auth\\state.json")
        print("      Bash:       rm auth/state.json")
        popup.close()
        return None

    print("   필터 팝업 열림")

    # 6. 소유자 검색
    # fill()은 JS 이벤트를 발생시키지 않아 AJAX 자동완성이 트리거되지 않음
    # → press_sequentially()로 한 글자씩 입력해야 드롭다운이 나타남
    print("6. 소유자 검색: 'jusungha' 입력...")
    try:
        popup.locator("#searchOwnerUserName").wait_for(timeout=10_000)
        popup.locator("#searchOwnerUserName").clear()
        popup.locator("#searchOwnerUserName").press_sequentially("jusungha", delay=80)
        # AJAX 자동완성 드롭다운이 나타날 때까지 대기
        popup.locator(".suggestions").wait_for(state="visible", timeout=10_000)
    except Exception as e:
        print(f"   ❌ #searchOwnerUserName 입력 실패: {e}")
        _dbg(popup, "step6_no_owner_input")
        popup.close()
        return None

    # 자동완성 클릭 — ID가 다를 수 있으므로 실패 시 후보 목록 출력
    try:
        popup.locator("#searchOwnerUserName_i_jusungha").wait_for(timeout=5_000)
        popup.locator("#searchOwnerUserName_i_jusungha").click()
        print("   'jusungha' 자동완성 선택 완료")
    except Exception as e:
        print(f"   ❌ 자동완성 #searchOwnerUserName_i_jusungha 클릭 실패: {e}")
        candidates = popup.locator('[id^="searchOwnerUserName_i_"]').all()
        if candidates:
            print(f"   [DBG] 실제 자동완성 후보 ID ({len(candidates)}개):")
            for c in candidates:
                print(f"        id={c.get_attribute('id')!r}  text={c.inner_text()!r}")
            print("   ⚠️  위 ID 중 올바른 것으로 SKILL.md / 코드를 수정하세요.")
        else:
            print("   [DBG] 자동완성 후보가 전혀 없음 — 입력 후 드롭다운이 뜨지 않았을 수 있습니다.")
        _dbg(popup, "step6_autocomplete_failed")
        popup.close()
        return None

    # 7. 검색 버튼 클릭
    print("7. 검색 버튼 클릭...")
    try:
        popup.locator('input[name="Search"][type="submit"]').click()
        popup.wait_for_load_state("networkidle")
        print("   검색 결과 로드 완료")
    except Exception as e:
        print(f"   ❌ 검색 버튼 클릭 실패: {e}")
        _dbg(popup, "step7_search_btn_failed")
        popup.close()
        return None

    # 8. 스프린트 필터 링크 선택
    print(f"8. 스프린트 필터 선택: {sprint_name!r}...")
    filter_links = popup.locator('a[id^="filterlink_"]').all()
    target = None
    for link in filter_links:
        if sprint_name in link.inner_text():
            target = link
            break

    if not target:
        available = [lnk.inner_text() for lnk in filter_links]
        print(f"   ❌ {sprint_name!r} 필터를 찾지 못했습니다.")
        print(f"   [DBG] 사용 가능한 필터 ({len(available)}개):")
        for name in available:
            print(f"        - {name!r}")
        print("   ⚠️  get_current_sprint_name() 반환값을 위 목록과 맞추세요.")
        _dbg(popup, "step8_no_filter_match")
        popup.close()
        return None

    try:
        target.click()
        popup.wait_for_event("close", timeout=10_000)
    except Exception:
        if not popup.is_closed():
            popup.close()
    page.wait_for_load_state("networkidle")
    print(f"   '{sprint_name}' 필터 선택 완료")

    # 9. 분류 기준 확인 및 '담당자' 설정
    print("9. 분류 기준 확인 (담당자)...")
    try:
        page.locator("#mapper_select").wait_for(timeout=10_000)
        current_val = page.locator("#mapper_select").evaluate("el => el.value")
        if current_val != "assignees":
            page.select_option("#mapper_select", value="assignees")
            print("   분류 기준을 '담당자'로 변경")
        else:
            print("   분류 기준: 담당자 (확인)")
    except Exception as e:
        print(f"   ❌ #mapper_select 처리 실패: {e}")
        # 페이지에 있는 select 요소 목록 출력
        selects = page.locator("select").all()
        print(f"   [DBG] 페이지 내 <select> 요소 ({len(selects)}개):")
        for s in selects:
            print(f"        id={s.get_attribute('id')!r}")
        _dbg(page, "step9_no_mapper_select")
        return None

    # 10. 보고서 생성
    print("10. '다음' 버튼 클릭 → 보고서 생성...")
    try:
        page.locator("#next_submit").wait_for(timeout=10_000)
        page.locator("#next_submit").click()
        page.wait_for_load_state("networkidle")
        print(f"   보고서 생성 완료: {page.url}")
    except Exception as e:
        print(f"   ❌ #next_submit 클릭 실패: {e}")
        submits = page.locator("input[type=submit], button[type=submit]").all()
        print(f"   [DBG] 페이지 내 submit 버튼 ({len(submits)}개):")
        for s in submits:
            print(f"        id={s.get_attribute('id')!r}  text={s.inner_text()[:40]!r}")
        _dbg(page, "step10_no_next_submit")
        return None

    return page.content()


# ---------------------------------------------------------------------------
# 보고서 HTML 파싱
# ---------------------------------------------------------------------------
def parse_report(html: str, target_users: list[str]) -> dict[str, dict]:
    """보고서 HTML에서 관심 대상 사용자의 이슈 데이터 파싱.

    Args:
        html: 보고서 페이지 HTML
        target_users: 조회할 사용자 nickname 목록

    Returns:
        {nickname: {"이름": str, "진행": str, "이슈": list[dict]}}
    """
    soup = BeautifulSoup(html, "lxml")
    all_user_data: dict[str, dict] = {}

    for heading in soup.find_all("th", class_="stat-heading"):
        user_link = heading.find("a", href=True)
        if not user_link:
            continue

        user_text = user_link.get_text(strip=True)
        nickname = ""
        if "(" in user_text and ")" in user_text:
            nickname = user_text.split("(")[-1].rstrip(")")

        if nickname not in target_users:
            continue

        progress_span = heading.find("span", class_="graphDescription")
        progress_text = progress_span.get_text(strip=True) if progress_span else ""

        heading_tr = heading.find_parent("tr")
        if not heading_tr:
            continue

        issues = []
        current_tr = heading_tr.find_next_sibling("tr")
        while current_tr:
            if current_tr.find("th", class_="stat-heading"):
                break

            issuekey_td = current_tr.find("td", {"data-type": "issuekey"})
            resolution_td = current_tr.find("td", {"data-type": "resolution"})
            details_td = current_tr.find("td", {"data-type": "details"})
            status_td = current_tr.find("td", {"data-type": "status"})

            if issuekey_td:
                key_link = issuekey_td.find("a")
                issue_key = key_link.get_text(strip=True) if key_link else ""
                issue_href = key_link["href"] if key_link and key_link.get("href") else ""
                issue_link = f"{BASE_URL}{issue_href}" if issue_href.startswith("/") else issue_href

                resolution = ""
                if resolution_td:
                    em = resolution_td.find("em")
                    resolution = em.get_text(strip=True) if em else resolution_td.get_text(strip=True)

                details = ""
                if details_td:
                    a = details_td.find("a")
                    details = a.get_text(strip=True) if a else details_td.get_text(strip=True)

                status = ""
                if status_td:
                    span = status_td.find("span")
                    status = span.get_text(strip=True) if span else status_td.get_text(strip=True)

                issues.append({
                    "이슈키": issue_key,
                    "링크": issue_link,
                    "제목": details,
                    "해결": resolution,
                    "상태": status,
                })

            current_tr = current_tr.find_next_sibling("tr")

        all_user_data[nickname] = {
            "이름": user_text,
            "진행": progress_text,
            "이슈": issues,
        }
        print(f"   {user_text}: {len(issues)}건")

    return all_user_data


# ---------------------------------------------------------------------------
# 보고서 HTML 빌더
# ---------------------------------------------------------------------------
def build_html_report(
    user_data: dict,
    sprint_name: str,
    target_users: list[str],
) -> str:
    """파싱된 보고서 데이터를 HTML 테이블로 변환."""
    today = datetime.now().strftime("%Y-%m-%d")
    html = (
        '<html><head><meta charset="utf-8"></head><body>\n'
        f"<h2>Sprint 단일 단위별 보고서 - {sprint_name}</h2>\n"
        f"<p>조회일: {today}</p>\n"
    )

    for nickname in target_users:
        if nickname not in user_data:
            continue
        data = user_data[nickname]
        html += (
            f"<h3>{data['이름']}</h3>\n"
            f"<p><b>진행:</b> {data['진행']}</p>\n"
            '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse; font-size:13px;">\n'
            '<tr style="background-color:#f0f0f0;">'
            "<th>이슈키</th><th>제목</th><th>해결</th><th>상태</th>"
            "</tr>\n"
        )
        for issue in data["이슈"]:
            html += (
                "<tr>"
                f'<td><a href="{issue["링크"]}">{issue["이슈키"]}</a></td>'
                f'<td>{issue["제목"]}</td>'
                f'<td>{issue["해결"]}</td>'
                f'<td>{issue["상태"]}</td>'
                "</tr>\n"
            )
        html += "</table>\n"

    missing = [u for u in target_users if u not in user_data]
    if missing:
        html += f"<p><i>※ 보고서에 이슈가 없는 사용자: {', '.join(missing)}</i></p>\n"

    html += "</body></html>"
    return html


# ---------------------------------------------------------------------------
# Dashboard 활동 스트림 크롤링
# ---------------------------------------------------------------------------
def fetch_dashboard_activities(
    page: Page,
    watch_users_lower: list[str] | None = None,
) -> list[dict]:
    """Dashboard 활동 스트림에서 오늘 감시 대상 사용자의 활동을 파싱.

    Args:
        page: 인증된 Playwright Page 객체
        watch_users_lower: 소문자 nickname 목록 (기본값: WATCH_USERS_LOWER)

    Returns:
        [{"작성자", "닉네임", "액션", "이슈키", "이슈링크", "시간"}, ...]
    """
    if watch_users_lower is None:
        watch_users_lower = WATCH_USERS_LOWER

    print("\n12. Dashboard 활동 스트림 조회 중...")
    page.goto(f"{BASE_URL}/secure/Dashboard.jspa")
    page.wait_for_load_state("networkidle")

    # 활동 스트림이 로드된 frame 탐색
    activity_frame = None
    for frame in page.frames:
        try:
            frame.wait_for_selector("ul.activity-items-list", timeout=5_000)
            activity_frame = frame
            print("   활동 스트림 frame 발견!")
            break
        except Exception:
            continue

    if not activity_frame:
        frame_urls = [f.url for f in page.frames]
        print(f"   활동 스트림 frame 없음 → 메인 페이지에서 시도")
        print(f"   [DBG] 로드된 frame URL 목록: {frame_urls}")
        _dbg(page, "dashboard_no_activity_frame")

    target_frame = activity_frame or page

    # '어제' 헤더가 나올 때까지 '활동 더 보기' 반복 클릭
    MAX_MORE_CLICKS = 30
    for i in range(MAX_MORE_CLICKS):
        headers = target_frame.locator("h4.date-header").all_inner_texts()
        if any("어제" in h for h in headers):
            print(f"   '어제' 헤더 발견 → 중단 ({i}회 클릭)")
            break
        try:
            btn = target_frame.locator("#activity-stream-show-more")
            if btn.count() > 0 and btn.is_visible():
                btn.click()
                page.wait_for_timeout(2_000)
                print(f"   '활동 더 보기' 클릭 ({i + 1}회)")
            else:
                print(f"   '활동 더 보기' 버튼 없음 → 중단 ({i}회)")
                break
        except Exception:
            print(f"   '활동 더 보기' 예외 → 중단 ({i}회)")
            break

    soup = BeautifulSoup(target_frame.content(), "lxml")

    today_header = soup.find("h4", class_="date-header", string=lambda t: t and "오늘" in t)
    if not today_header:
        print("   '오늘' 항목이 없습니다.")
        return []

    activity_lists = []
    sibling = today_header.find_next_sibling()
    while sibling:
        if sibling.name == "h4" and "date-header" in (sibling.get("class") or []):
            break
        if sibling.name == "ul" and "activity-items-list" in (sibling.get("class") or []):
            activity_lists.append(sibling)
        sibling = sibling.find_next_sibling()

    if not activity_lists:
        print("   '오늘' 활동 목록이 없습니다.")
        return []

    items = []
    for al in activity_lists:
        items.extend(al.find_all("li", recursive=False))
    print(f"   '오늘' 활동 항목 수: {len(items)}건 (리스트 {len(activity_lists)}개)")

    activities = []
    seen_nicknames: set[str] = set()

    for item in items:
        author_el = item.find("a", class_="activity-item-author")
        if not author_el:
            continue

        author_href = author_el.get("href", "")
        nickname = ""
        if "name=" in author_href:
            nickname = author_href.split("name=")[-1].split("&")[0]

        seen_nicknames.add(nickname)

        if nickname.lower() not in watch_users_lower:
            continue

        author_name = author_el.get_text(strip=True)

        summary_el = item.find("div", class_="activity-item-summary")
        action_type = ""
        issue_key = ""
        issue_link = ""

        if summary_el:
            for a in summary_el.find_all("a", href=True):
                href = a.get("href", "")
                if "/browse/" in href:
                    issue_key = href.split("/browse/")[-1].split("?")[0]
                    issue_link = f"{BASE_URL}{href}" if href.startswith("/") else href
                    break

            summary_clone = summary_el.__copy__()
            for a in summary_clone.find_all("a"):
                a.decompose()
            raw_action = summary_clone.get_text(" ", strip=True)

            if "상태" in raw_action or "변경" in raw_action:
                action_type = raw_action.strip()
            elif "댓글" in raw_action or not raw_action.strip():
                action_type = "댓글 남김"
            else:
                action_type = raw_action.strip()

            if len(action_type) > 80:
                action_type = action_type[:80] + "..."

        time_el = item.find("span", class_="timestamp")
        timestamp = ""
        if time_el:
            timestamp = time_el.get("datetime", "") or time_el.get_text(strip=True)

        activities.append({
            "작성자": author_name,
            "닉네임": nickname,
            "액션": action_type,
            "이슈키": issue_key,
            "이슈링크": issue_link,
            "시간": timestamp,
        })

    print(f"   활동 스트림 내 전체 사용자: {sorted(seen_nicknames)}")
    matched = {a["닉네임"] for a in activities}
    missed = set(WATCH_USERS) - {w for w in WATCH_USERS if w.lower() in {n.lower() for n in matched}}
    print(f"   감시 대상 매칭: {sorted(matched)}")
    if missed:
        print(f"   감시 대상 미감지: {sorted(missed)} (활동 없음 또는 스트림 미포함)")

    print(f"   감시 대상 오늘 활동 {len(activities)}건 조회 완료")
    return activities


# ---------------------------------------------------------------------------
# 감시 대상 활동 HTML 빌더
# ---------------------------------------------------------------------------
def build_watch_html(activities: list[dict]) -> str:
    """감시 대상 활동 내역을 HTML 테이블로 변환."""
    html = "<hr>\n<h2>[LGAP] 감시 대상 오늘 활동 내역</h2>\n"

    if not activities:
        html += "<p><i>오늘 감시 대상의 활동이 없습니다.</i></p>"
        return html

    html += (
        f"<p>총 {len(activities)}건의 활동이 감지되었습니다.</p>\n"
        '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse; font-size:13px;">\n'
        '<tr style="background-color:#f0f0f0;">'
        "<th>시간</th><th>작성자</th><th>이슈</th><th>활동</th>"
        "</tr>\n"
    )

    for act in activities:
        issue_cell = ""
        if act["이슈키"]:
            issue_cell = f'<a href="{act["이슈링크"]}">{act["이슈키"]}</a>'

        time_display = act["시간"]
        if "T" in time_display:
            try:
                dt = datetime.fromisoformat(time_display.replace("Z", "+00:00"))
                if dt.tzinfo and dt.utcoffset().total_seconds() == 0:
                    dt = dt + timedelta(hours=9)
                time_display = dt.strftime("%H:%M")
            except (ValueError, AttributeError):
                pass

        html += (
            "<tr>"
            f"<td>{time_display}</td>"
            f'<td>{act["작성자"]}</td>'
            f"<td>{issue_cell}</td>"
            f'<td>{act["액션"]}</td>'
            "</tr>\n"
        )

    html += "</table>"
    return html


# ---------------------------------------------------------------------------
# 전체 보고서 생성 진입점
# ---------------------------------------------------------------------------
def generate_reports(headless: bool = True) -> dict[str, str] | None:
    """스프린트 보고서 + 감시 대상 활동 보고서를 생성하여 HTML 파일로 저장.

    Returns:
        {"1": html_for_target1, "2": html_for_target2} or None
    """
    sprint_name = get_current_sprint_name()
    all_target_users = list(dict.fromkeys(TARGET_USERS1 + TARGET_USERS2))

    with sync_playwright() as p:
        ctx = ensure_session(p, headless=headless)
        page = ctx.new_page()

        try:
            report_html = navigate_to_report(page, sprint_name)
            user_data: dict = {}
            if report_html:
                print("\n11. 보고서 파싱 중...")
                user_data = parse_report(report_html, all_target_users)
                if not user_data:
                    print("   관심 대상 사용자의 이슈를 찾지 못했습니다.")
            else:
                print("보고서 생성 실패")

            activities = fetch_dashboard_activities(page)
            watch_html = build_watch_html(activities) if activities else ""
            if not activities:
                print("\n13. 감시 대상 오늘 활동 없음 → 활동 섹션 생략")

            if not user_data and not activities:
                print("\n보고서 생성 실패 및 감시 대상 활동 없음")
                return None

            results = {}
            today = datetime.now().strftime("%Y-%m-%d")
            for label, target_users, output_path in [
                ("1", TARGET_USERS1, "report1.html"),
                ("2", TARGET_USERS2, "report2.html"),
            ]:
                if user_data:
                    email_html = build_html_report(user_data, sprint_name, target_users)
                else:
                    email_html = (
                        '<html><head><meta charset="utf-8"></head><body>\n'
                        f"<p>조회일: {today}</p>\n"
                        "<p><i>※ 스프린트 보고서 생성에 실패하여 감시 대상 활동 내역만 포함합니다.</i></p>\n"
                        "</body></html>"
                    )

                if watch_html:
                    email_html = email_html.replace("</body>", f"{watch_html}</body>")

                with open(output_path, "w", encoding="utf-8") as f:
                    f.write(email_html)
                print(f"\n보고서 저장 완료: {output_path}")
                results[label] = email_html

            return results

        finally:
            page.close()
            ctx.close()


if __name__ == "__main__":
    generate_reports(headless=True)
