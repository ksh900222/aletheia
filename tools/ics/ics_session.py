"""ICS 세션 관리: storageState 재사용 + 만료 시 자동 재로그인."""
from __future__ import annotations

import os
from pathlib import Path

import keyring
from dotenv import load_dotenv
from playwright.sync_api import BrowserContext, Playwright, sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]

load_dotenv(REPO_ROOT / ".env")
load_dotenv(SCRIPT_DIR / ".env")

BASE_URL = (os.getenv("ICS_BASE_URL") or "").rstrip("/")
if not BASE_URL:
    raise RuntimeError(".env 파일에 ICS_BASE_URL 을 설정하세요.")
DASHBOARD_URL = f"{BASE_URL}/secure/Dashboard.jspa"
LOGIN_URL = f"{BASE_URL}/login.jsp"

SSO_ID = os.getenv("ICS_ID") or os.getenv("ICS_SSO_ID")
if not SSO_ID:
    raise RuntimeError(".env 파일에 ICS_ID 또는 ICS_SSO_ID 를 설정하세요.")
KEYRING_SERVICE = os.getenv("ICS_KEYRING_SERVICE", "ICS_SSO")
STATE_PATH = SCRIPT_DIR / "auth" / "state.json"


def _get_password() -> str:
    pw = (os.getenv("ICS_SSO_PW") or keyring.get_password(KEYRING_SERVICE, SSO_ID) or "").strip()
    if not pw:
        raise RuntimeError(
            "ICS 비밀번호가 Credential Manager에 없습니다. 다음 명령으로 저장하세요:\n"
            f"  python -c \"import keyring, getpass; keyring.set_password('{KEYRING_SERVICE}', '{SSO_ID}', getpass.getpass())\""
        )
    return pw


def _do_login(context: BrowserContext) -> None:
    """실제 로그인 수행. CAPTCHA 발생 시 사용자 개입 대기."""
    page = context.new_page()
    page.goto(LOGIN_URL)
    page.fill("#login-form-username", SSO_ID)
    page.fill("#login-form-password", _get_password())
    page.locator("#login-form-submit, input[name='login']").first.click()
    page.wait_for_load_state("networkidle")

    if "login" in page.url.lower():
        error_loc = page.locator(".aui-message-error, .error").first
        msg = error_loc.inner_text() if error_loc.count() > 0 else "(원인 불명)"
        if "CAPTCHA" in msg.upper() or "captcha" in msg:
            print(f"⚠️  CAPTCHA 발생: {msg}")
            print("   브라우저에서 직접 로그인을 완료한 뒤 터미널에 엔터를 누르세요.")
            input()
            page.goto(DASHBOARD_URL)
            page.wait_for_load_state("networkidle")
            if "login" in page.url.lower():
                raise RuntimeError("수동 로그인 후에도 인증되지 않음.")
        else:
            raise RuntimeError(f"로그인 실패: {msg}")

    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(STATE_PATH))
    page.close()


def _is_authenticated(context: BrowserContext) -> bool:
    # Dashboard 는 통과해도 popup 계열이 만료된 경우가 있으므로
    # FilterPickerPopup 도 함께 확인한다.
    _CHECKS = [
        DASHBOARD_URL,
        f"{BASE_URL}/secure/FilterPickerPopup.jspa?showProjects=false&field=filterid",
    ]
    page = context.new_page()
    try:
        for url in _CHECKS:
            page.goto(url, wait_until="domcontentloaded")
            if "login" in page.url.lower():
                return False
        return True
    finally:
        page.close()


def ensure_session(p: Playwright, headless: bool = True) -> BrowserContext:
    """유효한 로그인 세션이 있는 BrowserContext 반환.

    1. state.json 이 있으면 로드 → Dashboard 접근 시도
    2. 인증 실패 시 자동 재로그인 (CAPTCHA 발생 시 사용자 개입 필요)
    """
    browser = p.chromium.launch(headless=headless)

    if STATE_PATH.exists():
        context = browser.new_context(storage_state=str(STATE_PATH))
        if _is_authenticated(context):
            return context
        print("저장된 세션이 만료됨. 재로그인 시도...")
        context.close()

    # CAPTCHA 가능성이 있으므로 재로그인은 항상 GUI 로
    if headless:
        browser.close()
        browser = p.chromium.launch(headless=False)
    context = browser.new_context()
    _do_login(context)
    return context


if __name__ == "__main__":
    with sync_playwright() as p:
        ctx = ensure_session(p, headless=False)
        page = ctx.new_page()
        page.goto(DASHBOARD_URL)
        print(f"세션 OK. 현재 URL: {page.url}")
        input("엔터로 종료...")
        ctx.close()
