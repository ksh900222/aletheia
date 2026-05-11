"""SharePoint [Camera] Backup 폴더의 파일 공유 링크 수집 → camera_attachments.md 업데이트.

사용법:
  uv run python crawl_sharepoint_links.py

핵심 원칙:
  - 로그인한 page 를 닫지 않고 REST API 호출에 그대로 재사용 (same-origin 보장)
  - headless=False 로 브라우저를 항상 표시
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]

load_dotenv(REPO_ROOT / ".env")
load_dotenv(SCRIPT_DIR / ".env")

SITE_URL = os.getenv("SP_SITE", "").rstrip("/")
FOLDER_REL = os.getenv("SP_FOLDER_REL", "")
FOLDER_PAGE = os.getenv("SP_FOLDER_PAGE", SITE_URL)
SITE_ORIGIN = ""
SITE_HOST = ""
if SITE_URL:
    parsed_site = urlparse(SITE_URL)
    SITE_HOST = parsed_site.netloc
    SITE_ORIGIN = f"{parsed_site.scheme}://{parsed_site.netloc}"

M365_STATE = SCRIPT_DIR / "auth" / "m365_state.json"
MD_PATH = SCRIPT_DIR / "camera_attachments.md"
DEBUG_JSON = SCRIPT_DIR / "debug" / "sp_links_raw.json"

# ── JavaScript (page.evaluate 용) ──────────────────────────────────────────────
_JS = """
async ([siteUrl, folderRel, siteOrigin]) => {
    const out = { pageUrl: location.href, files: [], links: {}, rawSamples: {}, errors: [] };

    // 현재 페이지가 SharePoint 인지 확인
    if (!location.href.includes('sharepoint.com')) {
        out.errors.push('NOT on SharePoint. Current URL: ' + location.href);
        return out;
    }

    // 1. Form Digest (POST 인증 토큰)
    let digest = '';
    try {
        const r = await fetch(siteUrl + '/_api/contextinfo', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json;odata=verbose',
                'Content-Type': 'application/json;odata=verbose'
            }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + await r.text());
        const d = await r.json();
        digest = d.d.GetContextWebInformation.FormDigestValue;
    } catch(e) {
        out.errors.push('[contextinfo] ' + e.toString());
        return out;
    }

    // 2. 폴더 내 파일 목록
    try {
        const url = siteUrl + "/_api/web/GetFolderByServerRelativeUrl('"
            + folderRel + "')/Files?$select=Name,ServerRelativeUrl&$top=300";
        const r = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json;odata=verbose' }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + await r.text());
        const d = await r.json();
        out.files = d.d.results.map(f => ({
            name: f.Name,
            fullUrl: siteOrigin + f.ServerRelativeUrl
        }));
    } catch(e) {
        out.errors.push('[file list] ' + e.toString());
        return out;
    }

    // 3. 파일별 공유 링크 (SP.Web.ShareObject)
    for (const file of out.files) {
        try {
            const r = await fetch(siteUrl + '/_api/SP.Web.ShareObject', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json;odata=verbose',
                    'Content-Type': 'application/json;odata=verbose',
                    'X-RequestDigest': digest
                },
                body: JSON.stringify({
                    url: file.fullUrl,
                    groupId: 0,
                    propagateAcl: false,
                    sendEmail: false,
                    includeAnonymousLinkInEmail: false,
                    role: 1,
                    useSimplifiedRoles: true
                })
            });

            const raw = await r.text();
            if (Object.keys(out.rawSamples).length < 2) {
                out.rawSamples[file.name] = raw.slice(0, 600);
            }

            let shareUrl = '';
            if (r.ok) {
                let d;
                try { d = JSON.parse(raw); } catch(_) {}
                if (d && d.d && d.d.ShareObject) {
                    const so = typeof d.d.ShareObject === 'string'
                        ? JSON.parse(d.d.ShareObject)
                        : d.d.ShareObject;
                    shareUrl = (so.sharingLinkInfo && so.sharingLinkInfo.Url)
                        ? so.sharingLinkInfo.Url
                        : (so.SharingLinkInfo && so.SharingLinkInfo.Url)
                        ? so.SharingLinkInfo.Url : '';
                }
            } else {
                out.errors.push('[share] ' + file.name + ' HTTP ' + r.status);
            }
            out.links[file.name] = shareUrl;
        } catch(e) {
            out.errors.push('[share] ' + file.name + ': ' + e.toString());
            out.links[file.name] = '';
        }
        await new Promise(res => setTimeout(res, 250));
    }
    return out;
}
"""

# ── 핵심 함수 ──────────────────────────────────────────────────────────────────

def open_authenticated_sharepoint_page(p):
    """SharePoint 폴더가 열린 상태의 (ctx, page) 반환.

    로그인이 필요하면 사용자가 GUI 에서 완료하도록 대기.
    반드시 headless=False 로 실행.
    """
    if not SITE_URL:
        raise RuntimeError(".env 파일에 SP_SITE 를 설정하세요.")
    if not FOLDER_REL:
        raise RuntimeError(".env 파일에 SP_FOLDER_REL 을 설정하세요.")
    if not FOLDER_PAGE:
        raise RuntimeError(".env 파일에 SP_FOLDER_PAGE 를 설정하세요.")

    browser = p.chromium.launch(headless=False)

    # 저장된 세션 시도
    if M365_STATE.exists():
        ctx = browser.new_context(storage_state=str(M365_STATE))
        page = ctx.new_page()
        print("Trying saved M365 session...")
        try:
            page.goto(FOLDER_PAGE, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass

        if SITE_HOST in page.url:
            print(f"Session OK. URL: {page.url[:80]}")
            return ctx, page

        print(f"Session expired (redirected to: {page.url[:80]})")
        ctx.close()
        browser.close()
        browser = p.chromium.launch(headless=False)

    # 새 로그인
    ctx = browser.new_context()
    page = ctx.new_page()
    page.goto(FOLDER_PAGE)

    print("\n" + "="*60)
    print("Browser opened. Please:")
    print("  1. Complete M365 login (MFA if needed)")
    print("  2. Wait until the SharePoint [Camera] Backup folder is visible")
    print("  3. Press Enter HERE (in this terminal)")
    print("="*60)
    input()

    current = page.url
    print(f"Current URL: {current[:100]}")

    if SITE_HOST not in current:
        print("WARNING: Not on SharePoint yet.")
        print("Navigate to the folder page, then press Enter again...")
        input()
        print(f"URL: {page.url[:100]}")

    # 세션 저장
    M365_STATE.parent.mkdir(parents=True, exist_ok=True)
    ctx.storage_state(path=str(M365_STATE))
    print(f"Session saved: {M365_STATE}")

    return ctx, page


def fetch_sharing_links(page) -> dict[str, str]:
    """인증된 SharePoint page 에서 REST API로 파일별 공유 링크 수집."""
    current = page.url
    if SITE_HOST not in current:
        print(f"Re-navigating to SharePoint (was: {current[:60]})...")
        try:
            page.goto(FOLDER_PAGE, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass

    print(f"Page URL: {page.url[:100]}")
    print("Calling SharePoint REST API... (may take 1-2 min)")

    result = page.evaluate(_JS, [SITE_URL, FOLDER_REL, SITE_ORIGIN])

    # 디버그 저장
    DEBUG_JSON.parent.mkdir(parents=True, exist_ok=True)
    DEBUG_JSON.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Raw response saved: {DEBUG_JSON}")

    if result.get("errors"):
        for e in result["errors"]:
            print(f"  [ERROR] {e}")

    files = result.get("files", [])
    links = result.get("links", {})
    ok = sum(1 for v in links.values() if v)
    print(f"\nFiles found: {len(files)} / Links collected: {ok}")
    for f in files:
        name = f["name"]
        url  = links.get(name, "")
        tag  = "OK " if url else "---"
        print(f"  [{tag}] {name}")

    return links


def strip_ticket_prefix(title: str) -> str:
    """LGAP-XXX_ 접두사 제거 → 원본 SharePoint 파일명."""
    return re.sub(r"^LGAP-\d+_", "", title)


def update_md(links: dict[str, str]) -> int:
    """camera_attachments.md 의 File link (Teams) 컬럼 채우기."""
    text  = MD_PATH.read_text(encoding="utf-8")
    lines = text.splitlines()
    updated = 0
    new_lines = []

    for line in lines:
        if not line.startswith("| ") or "| No. |" in line or "|:---:|" in line:
            new_lines.append(line)
            continue

        parts = line.split("|")
        # '' | No | Title | Desc | Author | Reviewer | Date | FileLink | Sprint | ICS | Remarks | ''
        if len(parts) < 12:
            new_lines.append(line)
            continue

        title = parts[2].strip()
        original_name = strip_ticket_prefix(title)

        if original_name in links and links[original_name]:
            parts[7] = f" [link]({links[original_name]}) "
            updated += 1

        new_lines.append("|".join(parts))

    MD_PATH.write_text("\n".join(new_lines), encoding="utf-8")
    return updated


# ── 진입점 ─────────────────────────────────────────────────────────────────────

def main():
    print("[1/3] Opening SharePoint (headless=False)...")
    with sync_playwright() as p:
        ctx, page = open_authenticated_sharepoint_page(p)

        print("\n[2/3] Fetching file sharing links...")
        links = fetch_sharing_links(page)
        ctx.close()

    print(f"\n[3/3] Updating {MD_PATH.name}...")
    count = update_md(links)
    print(f"\nDone! {count} links filled in {MD_PATH.name}")


if __name__ == "__main__":
    main()
