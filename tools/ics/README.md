# ICS / SharePoint 자동화 도구

LG이노텍 ICS(Jira) 로그인·크롤링 및 SharePoint 파일 링크 수집 자동화 스크립트입니다.

## 파일 구성

```
tools/ics/
├── ICS_send_PW_v7.py           # ICS 비밀번호 크롤 후 Teams 자기 채팅으로 전송 (Windows 전용)
├── save_password.py            # SSO 비밀번호 저장 헬퍼 (setup 스크립트에서 자동 호출)
│
├── setup_uv.bat                # [uv 방법] 최초 설치 (uv + 패키지 + 비밀번호 저장)
├── run.bat                     # [uv 방법] 실행
│
├── setup_pip.bat               # [pip 방법] 최초 설치 (pip + 패키지 + 비밀번호 저장)
├── run_pip.bat                 # [pip 방법] 실행
├── requirements_windows.txt    # [pip 방법] 의존성 목록
│
├── ICS_read_PW_v1.py           # Teams 자기 채팅에서 최신 메시지 읽기 (Linux 전용)
├── ics_session.py              # ICS 세션 관리 (자동 재로그인, Linux)
├── ics_crawling.py             # ICS 티켓/스프린트 크롤링 함수 (Linux)
├── ics_fetch.py                # ICS 페이지 fetch 유틸 (Linux)
├── sync_sprint_to_aletheia.py  # 현재 스프린트 이슈 → aletheia 스케줄 등록
├── auth/                       # 세션 상태 파일 (gitignore)
└── pyproject.toml
```

---

## Windows (Cloud) — ICS 비밀번호 크롤 & Teams 전송

> ICS 포털에 로그인해 `icsPwd` 쿠키를 크롤하고, 본인 Teams 자기 채팅으로 전송합니다.  
> **.env 파일 불필요** — 회사 공용 URL은 스크립트에 내장되어 있습니다.

---

### 방법 1: uv 사용 (권장)

uv는 Python 버전과 패키지를 한 번에 관리해주는 도구입니다.

#### 최초 설치 (1회)

`tools/ics/` 폴더에서 `setup_uv.bat` 를 더블클릭 또는 실행합니다.

```
setup_uv.bat 이 자동으로 수행하는 작업:
  1. uv 설치 (없을 경우 winget으로 자동 설치)
  2. uv sync (SSL trusted-host 포함) — 필요한 Python 패키지 설치
  3. save_password.py — SSO 비밀번호를 Windows Credential Manager에 저장
```

> uv가 없고 `winget`도 없다면 먼저 [uv 설치](https://docs.astral.sh/uv/getting-started/installation/)를 직접 해주세요.

> **SSL 오류 발생 시**: 회사 네트워크 정책으로 SSL 인증서 오류가 날 수 있습니다.  
> `setup_uv.bat`은 `--allow-insecure-host` 옵션을 자동으로 포함합니다.  
> 직접 실행할 경우:
> ```cmd
> uv sync --allow-insecure-host pypi.org --allow-insecure-host files.pythonhosted.org
> ```

#### 실행

```
run.bat 더블클릭 → SSO ID와 Teams 이메일 입력 → 자동 전송
```

또는 CMD에서 직접:

```powershell
.venv\Scripts\python.exe ICS_send_PW_v7.py --sso-id 본인사번 --teams-user 본인사번@lginnotek.com --browser edge --send-delay 20 --teams-ready-timeout 60
```

---

### 방법 2: pip 사용 (Python이 이미 설치된 경우)

Python이 이미 설치되어 있고 uv를 쓰지 않는 경우 사용합니다.

#### 최초 설치 (1회)

`tools/ics/` 폴더에서 `setup_pip.bat` 를 더블클릭 또는 실행합니다.

```
setup_pip.bat 이 자동으로 수행하는 작업:
  1. Python 설치 여부 확인
  2. pip install -r requirements_windows.txt (SSL trusted-host 포함) — 필요한 패키지 설치
  3. save_password.py — SSO 비밀번호를 Windows Credential Manager에 저장
```

> Python이 없다면 [python.org](https://www.python.org/downloads/) 에서 설치하세요.  
> 설치 시 **"Add Python to PATH"** 옵션을 반드시 체크하세요.

> **SSL 오류 발생 시**: 회사 네트워크 정책으로 SSL 인증서 오류가 날 수 있습니다.  
> `setup_pip.bat`은 `--trusted-host pypi.org --trusted-host files.pythonhosted.org` 옵션을 자동으로 포함합니다.  
> 직접 설치할 경우:
> ```cmd
> python -m pip install -r requirements_windows.txt --trusted-host pypi.org --trusted-host files.pythonhosted.org
> ```

#### 실행

```
run_pip.bat 더블클릭 → SSO ID와 Teams 이메일 입력 → 자동 전송
```

또는 CMD에서 직접:

```powershell
python ICS_send_PW_v7.py --sso-id 본인사번 --teams-user 본인사번@lginnotek.com --browser edge --send-delay 20 --teams-ready-timeout 60
```

---

### 전송키 문제 시 (메시지가 입력창에 남아있는 경우)

Teams 설정에 따라 전송 단축키가 다를 수 있습니다. `--send-key` 옵션을 추가하세요.

```powershell
# Ctrl+Enter 로 전송 시도
.venv\Scripts\python.exe ICS_send_PW_v7.py --sso-id 본인사번 --teams-user 본인사번@lginnotek.com --browser edge --send-delay 20 --teams-ready-timeout 60 --send-key ctrl+enter

# Enter 로 전송 시도
.venv\Scripts\python.exe ICS_send_PW_v7.py --sso-id 본인사번 --teams-user 본인사번@lginnotek.com --browser edge --send-delay 20 --teams-ready-timeout 60 --send-key enter
```

### 비밀번호 변경 시

SSO 비밀번호가 바뀌면 `save_password.py`를 다시 실행합니다.

```powershell
# uv
.venv\Scripts\python.exe save_password.py

# pip
python save_password.py
```

---

## Linux (Local) — ICS 자동화 도구

> `ics_session.py`, `ics_crawling.py`, `ics_fetch.py` 등 Linux 환경 전용 도구.  
> Playwright 기반으로 ICS(Jira) 세션을 관리하고 스프린트·칸반 데이터를 크롤링합니다.

### 1단계: uv 설치 (없을 경우)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2단계: 의존성 및 Playwright 설치

```bash
cd tools/ics
uv sync
uv run playwright install chromium

# Playwright 시스템 의존성 설치 (필요 시)
# uv run playwright install-deps chromium
```

> **Linux keyring**: GNOME Secret Service(libsecret) 또는 KWallet이 필요합니다.  
> 없으면 `sudo apt install gnome-keyring libsecret-tools` 후 로그인 세션에서 실행하세요.

### 3단계: `.env` 파일 생성

`tools/ics/.env` 파일을 직접 생성합니다 (gitignore 처리됨).

```
ICS_BASE_URL=https://ics.lginnotek.com:48011
ICS_ID=본인사번
TEAMS_SELF_UPN=본인사번@lginnotek.com
```

### 4단계: ICS SSO 비밀번호 저장 (최초 1회)

```bash
uv run python save_password.py
```

### 5단계: 동작 확인

```bash
# ICS 접속 테스트 (기본 Dashboard)
uv run python ics_fetch.py

# 스프린트 보고서 + 활동 스트림 생성 (report1.html, report2.html)
uv run python ics_crawling.py
```

첫 실행 시 브라우저가 열리고 로그인합니다. 이후 세션이 `auth/state.json`에 저장되어 재사용됩니다.

> MFA(다단계 인증) 화면이 나타나면 직접 인증을 완료하세요.

---

## SharePoint 링크 수집 (Linux)

`tools/sharepoint/.env` 파일을 생성합니다.

```
SP_USER=본인계정@lginnotek.com
SP_SITE=https://lginnotek.sharepoint.com/sites/YourSite
SP_FOLDER_REL=/sites/YourSite/Shared Documents/Folder
SP_FOLDER_PAGE=https://lginnotek.sharepoint.com/sites/YourSite/Shared%20Documents/Forms/AllItems.aspx
```

SharePoint(M365) 비밀번호 저장:

```bash
uv run python -c "import keyring, getpass; keyring.set_password('M365_SP', '본인사번@lginnotek.com', getpass.getpass('Password: '))"
```

동작 확인:

```bash
cd tools/sharepoint
uv run python crawl_sharepoint_links.py
```

---

## 보안 주의사항

- `auth/` 폴더는 개인 세션 토큰을 포함합니다. **절대 공유하지 마세요.** (`.gitignore` 처리됨)
- 비밀번호는 코드나 파일에 저장하지 않고 OS Credential Manager(Windows) 또는 keyring(Linux)에만 저장합니다.
d