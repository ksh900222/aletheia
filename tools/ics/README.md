# ICS / SharePoint 자동화 도구

LG이노텍 ICS(Jira) 로그인·크롤링 및 SharePoint 파일 링크 수집 자동화 스크립트입니다.

## 파일 구성

```
tools/
├── ics/                        # ICS(Jira) 자동화
│   ├── ics_session.py          # ICS 세션 관리 (자동 재로그인)
│   ├── ics_crawling.py         # ICS 티켓/스프린트 크롤링 함수
│   ├── ics_fetch.py            # ICS 페이지 fetch 유틸
│   ├── sync_sprint_to_aletheia.py  # 현재 스프린트 이슈 → aletheia 스케줄 등록
│   ├── auth/                   # 세션 상태 파일 (gitignore)
│   └── pyproject.toml
└── sharepoint/                 # SharePoint/Teams 자동화
    ├── sp_session.py           # SharePoint/M365 세션 관리
    ├── crawl_sharepoint_links.py   # SharePoint 폴더 파일 링크 수집
    ├── auth/                   # 세션 상태 파일 (gitignore)
    └── pyproject.toml
```

---

## 사전 요구사항

- Windows 10/11 또는 Linux (Ubuntu 20.04+)
- [uv](https://docs.astral.sh/uv/) 패키지 매니저

### uv 설치 (없을 경우)

**Windows**
```powershell
winget install --id=astral-sh.uv -e
```

**Linux**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## 설치

```bash
cd tools/ics
uv sync
uv run playwright install chromium

# Linux 전용: Playwright 시스템 의존성 설치
# uv run playwright install-deps chromium
```

> **Linux keyring**: GNOME Secret Service(libsecret) 또는 KWallet이 필요합니다.  
> 없으면 `sudo apt install gnome-keyring libsecret-tools` 후 로그인 세션에서 실행하세요.

---

## 초기 설정

### 1. `.env` 파일 생성

각 도구 디렉토리에 `.env` 파일을 직접 생성합니다 (gitignore 처리됨).

**`tools/ics/.env`**
```
ICS_BASE_URL=https://ics.example.com:48011
ICS_PORTAL_URL=https://portal.example.com/portal/main/portalMain.do#
ICS_SSO_URL=https://ics.example.com:48011/sso/checkIcsLogin.jsp
ICS_ID=본인사번
```

**`tools/sharepoint/.env`** (SharePoint 사용 시)
```
SP_USER=본인계정@example.com
SP_SITE=https://example.sharepoint.com/sites/YourSite
SP_FOLDER_REL=/sites/YourSite/Shared Documents/Folder
SP_FOLDER_PAGE=https://example.sharepoint.com/sites/YourSite/Shared%20Documents/Forms/AllItems.aspx
```

### 2. ICS 비밀번호 저장

```powershell
uv run python -c "import keyring, getpass; keyring.set_password('ICS_SSO', '본인사번', getpass.getpass('Password: '))"
```

> 비밀번호 길이로 저장 확인:
> ```powershell
> uv run python -c "import keyring; pw = keyring.get_password('ICS_SSO', '본인사번'); print(f'길이: {len(pw) if pw else 0}')"
> ```

### 3. SharePoint(M365) 비밀번호 저장

```powershell
uv run python -c "import keyring, getpass; keyring.set_password('M365_SP', '본인사번@lginnotek.com', getpass.getpass('Password: '))"
```

> 비밀번호 길이로 저장 확인:
> ```powershell
> uv run python -c "import keyring; pw = keyring.get_password('M365_SP', '본인사번@lginnotek.com'); print(f'길이: {len(pw) if pw else 0}')"
> ```

> **비밀번호 변경 시**: `docs/ics_password_update.md`, `docs/sharepoint_password_update.md` 참고

---

## 동작 확인

```powershell
# ICS 접속 테스트
uv run python ics_fetch.py

# SharePoint 링크 수집 테스트
uv run python crawl_sharepoint_links.py
```

첫 실행 시 브라우저가 열리고 로그인합니다. 이후 세션이 `auth/` 폴더에 저장되어 재사용됩니다.

> MFA(다단계 인증) 화면이 나타나면 직접 인증을 완료하세요.

---

## 보안 주의사항

- `auth/` 폴더는 개인 세션 토큰을 포함합니다. **절대 공유하지 마세요.** (`.gitignore` 처리됨)
- 비밀번호는 코드나 `.env`에 저장하지 않고 Windows Credential Manager에만 저장합니다.
