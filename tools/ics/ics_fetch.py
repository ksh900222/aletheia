"""ICS 페이지 접근 테스트.

사용법:
  uv run python ics_fetch.py                          # 기본: Dashboard
  uv run python ics_fetch.py /secure/Dashboard.jspa   # 경로 지정
  uv run python ics_fetch.py https://...              # 전체 URL 지정

세션은 ics_session.ensure_session() 으로 자동 관리됨.
페이지 제목, URL, 주요 구조 정보를 출력하고 HTML 을 last_page.html 에 저장.
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from ics_session import BASE_URL, DASHBOARD_URL, ensure_session


def fetch(target: str, headless: bool = True, save: bool = True) -> dict:
    """대상 URL/경로 접근 후 페이지 정보 반환."""
    if target.startswith("http"):
        url = target
    else:
        url = BASE_URL + (target if target.startswith("/") else "/" + target)

    with sync_playwright() as p:
        ctx = ensure_session(p, headless=headless)
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass

        info = {
            "requested": url,
            "final_url": page.url,
            "title": page.title(),
            "is_login_redirect": "login" in page.url.lower(),
            "iframe_count": len(page.locator("iframe").all()),
            "h1": [el.inner_text() for el in page.locator("h1").all()[:5]],
            "h2": [el.inner_text() for el in page.locator("h2").all()[:5]],
        }

        if save:
            out = Path(__file__).parent / "last_page.html"
            out.write_text(page.content(), encoding="utf-8")
            info["saved_to"] = str(out)

        ctx.close()
        return info


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else DASHBOARD_URL
    info = fetch(target, headless=True)
    print("=" * 60)
    for k, v in info.items():
        print(f"{k:18}: {v}")
    print("=" * 60)
    if info["is_login_redirect"]:
        print("⚠️  로그인 페이지로 리다이렉트됨 — 세션 만료 가능성")
        sys.exit(1)


if __name__ == "__main__":
    main()
