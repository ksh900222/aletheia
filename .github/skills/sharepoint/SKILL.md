---
name: sharepoint
description: LG이노텍 SharePoint/Teams 자동화 도구. M365 로그인 세션 관리, SharePoint 폴더 파일 목록 조회, 파일 URL 수집, camera_attachments.md 업데이트. USE FOR; Teams 파일 접근, SharePoint 크롤링, VnV 폴더 파일 링크 수집, camera_attachments.md File link 채우기. DO NOT USE FOR; ICS/Jira 티켓 작업 (→ /ics-jira 사용), 이메일 발송.
---

# SharePoint / Teams 자동화 Skill

## 목적
`.env`에 설정된 SharePoint 사이트(`SP_SITE`)에 M365 자동 로그인하여 파일 목록 조회, URL 수집, `camera_attachments.md` 업데이트 작업을 수행합니다.

## 핵심 원칙
- **비밀번호는 절대 prompt/코드에 포함하지 않음.** Windows Credential Manager(`keyring`) 에서만 읽음.
- **세션 재사용**: `auth/m365_state.json` 에 storageState 저장. 매번 로그인하지 않음.
- **MFA 발생 시 사람 개입 필요**: 자동 우회 시도 금지. GUI 브라우저에서 사용자가 직접 완료.
- **로그인한 page 를 그대로 REST API 호출에 재사용** (same-origin 보장, 401 방지).

## 인증 정보 위치
| 항목 | 저장소 | 키 |
|---|---|---|
| 이메일 | `.env` | `SP_USER` |
| 사이트 URL | `.env` | `SP_SITE` |
| 대상 폴더 | `.env` | `SP_FOLDER_REL`, `SP_FOLDER_PAGE` |
| Password | Credential Manager | service=`M365_SP`, user=`SP_USER` 값 |
| 세션 상태 | `auth/m365_state.json` | (gitignore 됨) |

## 사용 가능한 함수 (sp_session.py)

```python
import os
from sp_session import ensure_session
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    ctx = ensure_session(p, headless=True)
    page = ctx.new_page()
    page.goto(os.environ["SP_SITE"])
    # ... 작업 수행 (page.evaluate 로 REST API 호출 등) ...
    ctx.close()
```

`ensure_session(p, headless=True)` 동작:
1. `auth/m365_state.json` 있으면 로드 → SharePoint 접근 가능 여부 확인
2. 만료된 경우 자동 재로그인 (MFA 시 GUI 띄우고 사용자 개입 대기)
3. 인증된 `BrowserContext` 반환

## SharePoint REST API 패턴 (page.evaluate 내부)

```javascript
// Form Digest 획득 (POST 요청 인증용)
const ctxResp = await fetch(siteUrl + '/_api/contextinfo', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose' }
});
const digest = (await ctxResp.json()).d.GetContextWebInformation.FormDigestValue;

// 폴더 내 파일 목록
const filesResp = await fetch(
    siteUrl + "/_api/web/GetFolderByServerRelativeUrl('" + folderRel + "')/Files?$select=Name,ServerRelativeUrl&$top=300",
    { credentials: 'include', headers: { 'Accept': 'application/json;odata=verbose' } }
);
const files = (await filesResp.json()).d.results;
```

**주의**: `page.evaluate()` 를 호출하는 page 의 URL 이 반드시 `SP_SITE`와 같은 SharePoint host여야 함. Microsoft 로그인 페이지에서 호출 시 → 401.

## 운영 명령어

### 비밀번호 저장 (최초 설정 또는 PW 변경 시)
```bash
python -c "import os, keyring, getpass; keyring.set_password('M365_SP', os.environ['SP_USER'], getpass.getpass('Password: '))"
```

### 저장된 비밀번호 길이 확인
```bash
python -c "import os, keyring; pw = keyring.get_password('M365_SP', os.environ['SP_USER']); print('Length:', len(pw) if pw else 0)"
```

### 세션 강제 초기화
```bash
rm -f tools/sharepoint/auth/m365_state.json
```

### 세션 상태 테스트
```bash
cd tools/sharepoint && uv run python sp_session.py
```

### SharePoint 링크 수집 실행
```bash
cd tools/sharepoint && uv run python crawl_sharepoint_links.py
```

## 주요 URL
- 사이트 홈: `.env`의 `SP_SITE`
- VnV Camera Backup 폴더: `.env`의 `SP_FOLDER_PAGE`
- REST API 기본 경로: `${SP_SITE}/_api/web/...`

## 실패 패턴 & 복구
| 증상 | 원인 | 복구 |
|---|---|---|
| REST API HTTP 401 | page 가 Microsoft 로그인 페이지에 있음 | 로그인 완료 후 SharePoint URL 확인 후 재시도 |
| REST API HTTP 400 | API 파라미터 오류 (e.g. SP.Web.ShareObject `role` 미지원) | 다른 API 엔드포인트 사용 |
| M365 세션 만료 | `m365_state.json` 만료 | 파일 삭제 후 재실행 |
| MFA 자동 실패 | 조직 MFA 정책 | GUI 브라우저에서 사용자가 직접 완료 후 엔터 |
| 비밀번호 없음 | Credential Manager 미설정 | `sharepoint_password_update.md` 참고 |

## 크롤링 스크립트 (crawl_sharepoint_links.py)

| 함수 | 설명 |
|---|---|
| `open_authenticated_sharepoint_page(p)` | M365 로그인 후 SharePoint 폴더가 열린 `(ctx, page)` 반환 |
| `fetch_sharing_links(page)` | REST API로 파일 목록 + URL 수집 → `dict[filename, url]` |
| `update_md(links)` | `camera_attachments.md` File link 컬럼 업데이트 |

### 실행 흐름
1. `sp_session.ensure_session()` → M365 인증
2. SharePoint 폴더 페이지 유지 (same-origin 보장)
3. `page.evaluate(_JS, ...)` → REST API로 파일 목록 조회
4. `debug/sp_links_raw.json` 에 원본 응답 저장
5. `camera_attachments.md` 자동 업데이트

## 관련 파일
- [sp_session.py](../../../tools/sharepoint/sp_session.py) — M365 세션 관리 핵심
- [crawl_sharepoint_links.py](../../../tools/sharepoint/crawl_sharepoint_links.py) — SharePoint 파일 링크 크롤러
- [camera_attachments.md](../../../tools/sharepoint/camera_attachments.md) — 결과 테이블
- [debug/sp_links_raw.json](../../../tools/sharepoint/debug/sp_links_raw.json) — REST API 원본 응답 (디버그용)
