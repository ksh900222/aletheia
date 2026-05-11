---
name: ics-jira
description: LG이노텍 ICS(Jira) 자동화 도구. 로그인 세션 관리, 대시보드 접근, 스프린트/칸반보드 데이터 조회. USE FOR; ICS 접속, ICS 로그인, Jira 자동화, 스프린트 보고서, 칸반보드, LGAP 프로젝트 관련 작업. DO NOT USE FOR; SharePoint/Teams 파일 작업 (→ /sharepoint 사용), 이메일 발송 단독 작업.
---

# ICS (LGAP Jira) 자동화 Skill

## 목적
`.env`에 설정된 ICS(`ICS_BASE_URL`) 에 자동 로그인하여 페이지/데이터를 가져오는 작업을 수행합니다.

## 핵심 원칙
- **비밀번호는 절대 prompt/코드에 포함하지 않음.** Windows Credential Manager(`keyring`) 에서만 읽음.
- **세션 재사용**: `auth/state.json` 에 storageState 저장. 매번 로그인하지 않음.
- **CAPTCHA 발생 시 사람 개입 필요**: 자동 우회 시도 금지.

## 인증 정보 위치
| 항목 | 저장소 | 키 |
|---|---|---|
| Base URL | `.env` | `ICS_BASE_URL` |
| ID | `.env` | `ICS_ID` 또는 `ICS_SSO_ID` |
| Password | Credential Manager | service=`ICS_SSO`, user=`ICS_ID` 값 |
| 세션 상태 | `auth/state.json` | (gitignore 됨) |

## 사용 가능한 함수 (ics_session.py)
```python
import os
from ics_session import ensure_session
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    ctx = ensure_session(p, headless=True)
    page = ctx.new_page()
    page.goto(f"{os.environ['ICS_BASE_URL']}/secure/Dashboard.jspa")
    # ... 작업 수행 ...
    ctx.close()
```

`ensure_session(p, headless=True)` 동작:
1. `auth/state.json` 있으면 로드 → Dashboard 접근 가능 여부 확인
2. 만료된 경우 자동 재로그인 (CAPTCHA 시 GUI 띄우고 사용자 개입 대기)
3. 인증된 `BrowserContext` 반환

## 페이지 접근 테스트 (ics_fetch.py)
임의의 ICS 페이지에 접근해 제목/URL/구조를 확인하고 HTML을 `last_page.html` 로 저장.

```powershell
uv run python ics_fetch.py                          # 기본 Dashboard
uv run python ics_fetch.py /secure/Dashboard.jspa   # 경로 지정
uv run python ics_fetch.py "/browse/LGAP-1234"      # 특정 이슈
```

Python에서 직접 호출:
```python
from ics_fetch import fetch
info = fetch("/secure/RapidBoard.jspa?projectKey=LGAP&rapidView=1582")
print(info["title"], info["final_url"])
```

반환 dict 키: `requested`, `final_url`, `title`, `is_login_redirect`, `iframe_count`, `h1`, `h2`, `saved_to`

## 운영 명령어

### 비밀번호 변경 (세션 만료/PW 갱신 시)
```bash
python -c "import os, keyring, getpass; keyring.set_password('ICS_SSO', os.environ['ICS_ID'], getpass.getpass('Password: '))"
```

### 저장된 비밀번호 길이 확인
```bash
python -c "import os, keyring; pw = keyring.get_password('ICS_SSO', os.environ['ICS_ID']); print('길이:', len(pw) if pw else 0)"
```

### 세션 상태 강제 초기화
```bash
rm -f tools/ics/auth/state.json
```

### 스크립트 실행
```bash
uv run python ics_session.py
```

## 주요 URL
- 로그인: `/login.jsp`
- 대시보드: `/secure/Dashboard.jspa`
- 스프린트 보고서: `/secure/ConfigureReport!default.jspa?reportKey=com.atlassian.jira.jira-core-reports-plugin:singlelevelgroupby&selectedProjectId=12302`
- 칸반보드(LGAP): `/secure/RapidBoard.jspa?projectKey=LGAP&rapidView=1582`

## 셀렉터
| 요소 | Selector |
|---|---|
| Username 입력 | `#login-form-username` |
| Password 입력 | `#login-form-password` |
| Log In 버튼 | `#login-form-submit` |
| 로그인 에러 메시지 | `.aui-message-error, .error` |

## 실패 패턴 & 복구
| 증상 | 원인 | 복구 |
|---|---|---|
| URL 에 `/login` 포함 | 세션 만료 | `auth/state.json` 삭제 후 재실행 |
| `your username and password are incorrect` | PW 불일치 (보통 SSO PW 변경됨) | Credential Manager 재저장 (위 명령어) |
| `CAPTCHA question` | 자동화 탐지/잠금 | GUI 띄워 수동 로그인 (스크립트가 자동 안내) |
| Playwright 미설치 | Chromium 없음 | `uv run playwright install chromium` |

## 크롤링 함수 (ics_crawling.py)

Selenium 없이 Playwright 세션만으로 사용 가능한 크롤링 함수 모음.

### 함수 목록

| 함수 | 설명 |
|---|---|
| `get_current_sprint_name()` | 현재 날짜 기준 활성 스프린트 필터명 반환 |
| `navigate_to_report(page, sprint_name)` | 단일 단위별 보고서 크롤링 → HTML 반환 |
| `parse_report(html, target_users)` | 보고서 HTML에서 사용자별 이슈 데이터 파싱 |
| `build_html_report(user_data, sprint_name, target_users)` | 파싱 결과를 HTML 테이블로 변환 |
| `fetch_dashboard_activities(page, watch_users_lower)` | Dashboard 활동 스트림에서 오늘 감시 대상 활동 파싱 |
| `build_watch_html(activities)` | 활동 내역을 HTML 테이블로 변환 |
| `generate_reports(headless)` | 위 함수를 전부 묶어 report1.html / report2.html 저장 |

### 사용 예시

```python
from ics_crawling import (
    get_current_sprint_name,
    navigate_to_report,
    parse_report,
    fetch_dashboard_activities,
    TARGET_USERS1,
)
from ics_session import ensure_session
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    ctx = ensure_session(p, headless=True)
    page = ctx.new_page()

    # 스프린트 보고서
    sprint = get_current_sprint_name()
    html = navigate_to_report(page, sprint)
    user_data = parse_report(html, TARGET_USERS1)

    # 활동 스트림
    activities = fetch_dashboard_activities(page)

    ctx.close()
```

CLI로 전체 보고서 한 번에 생성:
```powershell
uv run python ics_crawling.py   # report1.html, report2.html 저장
```

### 설정 상수

| 상수 | 설명 |
|---|---|
| `TARGET_USERS1` | 스프린트 보고서 관심 대상 (내부 팀원) |
| `TARGET_USERS2` | 스프린트 보고서 관심 대상 (외부 팀원) |
| `WATCH_USERS` | 활동 스트림 감시 대상 |
| `SPRINT02_START` | Sprint02 시작일 (자동 계산 기준) |

### 주의사항
- `navigate_to_report` 내부에서 팝업 윈도우(`filter_filterid_button`)가 열림 → `expect_popup()` 처리
- Dashboard 활동 스트림은 `<iframe>` 안에 로드됨 → `page.frames` 탐색
- `get_current_sprint_name()` 은 현재 필터명이 하드코딩 → 실제 운영 시 교체 필요

## 관련 파일
- [ics_session.py](../../../tools/ics/ics_session.py) — 세션 관리 핵심
- [ics_crawling.py](../../../tools/ics/ics_crawling.py) — 크롤링 함수 (Playwright 기반)
- [ics_fetch.py](../../../tools/ics/ics_fetch.py) — 단일 페이지 접근 테스트용
- [ics_login.py](../../../tools/ics/ics_login.py) — 단순 로그인 테스트용
- [crawl_ics_temp.py](../../../tools/ics/crawl_ics_temp.py) — 구버전 Selenium 기반 (참고용)

## 향후 추가 예정
- `get_current_sprint_name()` 자동 계산 로직 복구 — ICS 실제 필터명 확인 필요
- `get_kanban_changes(since)` — 칸반보드 변경사항 조회
- 헤드리스 모드 정상 동작 확인 (현재 GUI 모드만 검증됨)
