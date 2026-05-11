"""SharePoint / Teams M365 세션 관리.

ics_session.py 와 동일한 패턴:
- 비밀번호: Windows Credential Manager (keyring), service='M365_SP'
- 계정 이메일: .env SP_USER
- SharePoint 사이트: .env SP_SITE
- 세션 상태: auth/m365_state.json (gitignore 됨)
"""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import keyring
from dotenv import load_dotenv
from playwright.sync_api import BrowserContext, Playwright, sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]

load_dotenv(REPO_ROOT / ".env")
load_dotenv(SCRIPT_DIR / ".env")

SP_USER = os.getenv("SP_USER")
if not SP_USER:
    raise RuntimeError(".env 파일에 SP_USER 를 설정하세요.")
SP_SITE = os.getenv("SP_SITE", "").rstrip("/")
if not SP_SITE:
    raise RuntimeError(".env 파일에 SP_SITE 를 설정하세요.")
SP_HOST = urlparse(SP_SITE).netloc
if not SP_HOST:
    raise RuntimeError("SP_SITE 값에서 host를 파싱할 수 없습니다.")
KEYRING_SERVICE = os.getenv("SP_KEYRING_SERVICE", "M365_SP")
STATE_PATH = SCRIPT_DIR / "auth" / "m365_state.json"

# Microsoft login 셀렉터
_EMAIL_SEL  = "#i0116, input[type='email'], input[name='loginfmt']"
_PW_SEL     = "#i0118, input[type='password'], input[name='passwd']"
_SUBMIT_SEL = "#idSIButton9, input[type='submit'][value='Next'], input[type='submit'][value='Sign in']"


def _get_password() -> str:
    pw = (os.getenv("SP_PASSWORD") or keyring.get_password(KEYRING_SERVICE, SP_USER) or "").strip()
    if not pw:
        raise RuntimeError(
            "M365 비밀번호가 Credential Manager에 없습니다. 다음 명령으로 저장하세요:\n"
            f"  python -c \"import keyring, getpass; "
            f"keyring.set_password('{KEYRING_SERVICE}', '{SP_USER}', getpass.getpass('Password: '))\""
        )
    return pw


def _do_login(context: BrowserContext) -> None:
    """M365 로그인 수행. MFA 발생 시 사용자 개입 대기."""
    page = context.new_page()
    page.goto(SP_SITE)
    page.wait_for_load_state("domcontentloaded")

    # 이미 SharePoint에 도달한 경우
    if SP_HOST in page.url and "microsoftonline" not in page.url:
        _save_state(context)
        page.close()
        return

    # Step 1: 이메일 입력
    email_loc = page.locator(_EMAIL_SEL).first
    if email_loc.count() > 0:
        try:
            email_loc.fill(SP_USER)
            page.locator(_SUBMIT_SEL).first.click()
            page.wait_for_load_state("domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=6000)
            except Exception:
                pass
        except Exception as e:
            print(f"[sp_session] 이메일 입력 실패: {e}")

    # Step 2: 비밀번호 입력
    pw_loc = page.locator(_PW_SEL).first
    if pw_loc.count() > 0:
        try:
            pw_loc.fill(_get_password())
            page.locator(_SUBMIT_SEL).first.click()
            page.wait_for_load_state("domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=6000)
            except Exception:
                pass
        except RuntimeError as e:
            print(f"[sp_session] {e}")
            print("브라우저에서 직접 비밀번호를 입력하세요...")
        except Exception as e:
            print(f"[sp_session] 비밀번호 입력 실패: {e}")

    # Step 3: MFA / 추가 인증 대기
    if SP_HOST not in page.url:
        print("\nMFA 또는 추가 인증이 필요합니다.")
        print("브라우저에서 인증을 완료한 뒤 SharePoint 페이지가 열리면 엔터를 누르세요...")
        input()

    # "로그인 상태 유지?" → Yes 클릭
    stay = page.locator("#idSIButton9")
    if stay.count() > 0 and SP_HOST not in page.url:
        try:
            stay.click()
            page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass

    _save_state(context)
    page.close()


def _save_state(context: BrowserContext) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(STATE_PATH))


def _is_authenticated(context: BrowserContext) -> bool:
    """SharePoint 사이트 접근 가능 여부 확인."""
    page = context.new_page()
    try:
        page.goto(SP_SITE, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
        return (
            SP_HOST in page.url
            and "microsoftonline" not in page.url
        )
    finally:
        page.close()


def ensure_session(p: Playwright, headless: bool = True) -> BrowserContext:
    """유효한 M365 SharePoint 세션이 있는 BrowserContext 반환.

    1. m365_state.json 있으면 로드 → SharePoint 접근 확인
    2. 인증 실패 시 자동 재로그인 (MFA 발생 시 GUI + 사용자 개입)
    """
    browser = p.chromium.launch(headless=headless)

    if STATE_PATH.exists():
        context = browser.new_context(storage_state=str(STATE_PATH))
        if _is_authenticated(context):
            return context
        print("M365 세션 만료. 재로그인 시도...")
        context.close()

    # MFA 가능성 → 재로그인은 항상 GUI로
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
        page.goto(SP_SITE)
        print(f"Session OK. URL: {page.url}")
        input("Press Enter to exit...")
        ctx.close()
