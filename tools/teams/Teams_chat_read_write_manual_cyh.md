# Teams Chat Read/Write Manual

이 문서는 `tools/teams/teams_chat_rw.py`를 다른 사람에게 설명하거나 전달할 때 참고하기 위한 매뉴얼입니다.

## 한 줄 요약

`teams_chat_rw.py`는 Microsoft Graph API를 쓰지 않고 Selenium으로 Teams Web을 열어서, 이미 로그인된 브라우저 세션을 이용해 Teams 채팅을 읽고, 메시지를 쓰고, 공유 파일 링크를 열거나 다운로드하는 CLI 도구입니다.

## 전체 구조

이 스크립트는 크게 네 층으로 나뉩니다.

1. CLI layer
   - `argparse`로 `login`, `read`, `write`, `files` 네 가지 subcommand를 받습니다.
   - 공통 옵션은 `--chat-url`, `--browser`, `--profile-dir`, `--headless`, `--timeout`, `--debug-dir`, `--keep-open`입니다.

2. Browser/session layer
   - Selenium WebDriver로 Chrome 또는 Edge를 실행합니다.
   - `--profile-dir`로 지정된 브라우저 profile을 사용합니다.
   - 기본 profile 경로는 `~/.cache/teams-chat-rw/chrome-profile`입니다.
   - Teams 로그인 정보는 코드 안이 아니라 이 브라우저 profile 안에 쿠키/세션 형태로 저장됩니다.

3. Teams Web DOM extraction layer
   - Teams Web 화면에서 JavaScript를 실행해 메시지, 작성자, 시간, 파일 링크를 추출합니다.
   - Graph API 호출이 아니라, 화면에 렌더링된 DOM을 읽는 방식입니다.
   - Teams UI가 바뀌면 selector 보정이 필요할 수 있습니다.

4. Command behavior layer
   - `login`: Teams 채팅을 열어 사용자가 직접 로그인할 시간을 줍니다.
   - `read`: 최근 메시지를 읽고 author/regex/limit 조건으로 필터링합니다.
   - `write`: compose box를 찾아 메시지를 입력하고 전송합니다.
   - `files`: 채팅에 보이는 파일 링크를 수집하고, 필요하면 열거나 다운로드합니다.

## Pipeline

### 공통 pipeline

```text
CLI 실행
-> 옵션/env 읽기
-> Chrome/Edge 선택
-> 지정된 browser profile로 Selenium 실행
-> Teams chat URL 열기
-> 로딩 overlay가 사라질 때까지 대기
-> subcommand별 동작 수행
-> 기본적으로 브라우저 종료
```

`--keep-open`을 주면 작업 후 브라우저를 닫지 않습니다.

### `login` pipeline

```text
브라우저 실행
-> Teams chat URL 열기
-> 사용자가 직접 회사 계정/MFA로 로그인
-> 지정된 시간 동안 대기
-> 로그인 세션이 profile directory에 저장됨
```

처음 쓰는 PC에서는 먼저 한 번 실행해야 합니다.

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py login --login-wait 300
```

### `read` pipeline

```text
Teams 채팅 열기
-> 채팅 화면을 아래로 스크롤
-> DOM에서 message body 후보를 찾음
-> 각 message root에서 text, author, time, file link 추출
-> 메시지 목록이 안정될 때까지 polling
-> author/text-regex/limit 적용
-> text 또는 JSON으로 출력
```

예시:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py read --limit 10
```

JSON으로 받기:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py read --limit 10 --json
```

특정 작성자 필터:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py read \
  --limit 10 \
  --author user@example.com \
  --author-alias 'user@example.com=Display Name|Korean Name'
```

Teams 화면에는 보통 이메일이 아니라 표시 이름이 나오므로, `--author`에 이메일을 넣는 경우 `--author-alias`가 거의 필요합니다.

### `write` pipeline

```text
메시지를 CLI 인자, 파일, stdin 중 하나에서 읽음
-> Teams 채팅 열기
-> compose box 후보를 DOM에서 찾음
-> 메시지를 입력함
-> --no-send가 아니면 Send 버튼 클릭 시도
-> 실패하면 Enter/Ctrl+Enter 방식으로 fallback
-> 보낸 메시지가 화면에 나타나는지 확인
```

메시지 전송:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py write \
  --message "안녕하세요. 테스트 메시지입니다."
```

미리 입력만 하고 전송하지 않기:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py write \
  --message "전송 전 확인용 메시지입니다." \
  --no-send
```

파일 내용을 메시지로 보내기:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py write \
  --message-file ./message.txt
```

### `files` pipeline

```text
Teams 채팅 열기
-> 메시지 안의 파일 링크 추출
-> 현재 화면에 보이는 파일성 anchor 링크도 추가 추출
-> 중복 제거
-> 목록 출력
-> --open이면 새 탭으로 열기
-> --download이면 SharePoint/OneDrive 링크에 download=1을 붙여 다운로드 시도
```

파일 링크 목록:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py files --limit 20
```

다운로드:

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py files \
  --download \
  --download-dir ./teams_downloads
```

## 할 수 있는 기능

| 기능 | 설명 |
|---|---|
| Teams 로그인 세션 생성 | `login`으로 브라우저를 열고 사용자가 직접 로그인합니다. |
| 최근 채팅 읽기 | `read`로 현재 로드된 최근 메시지를 읽습니다. |
| 작성자 필터 | `--author`, `--author-alias`로 특정 작성자 메시지만 볼 수 있습니다. |
| 키워드/정규식 필터 | `--text-regex`로 메시지 본문을 필터링합니다. |
| JSON 출력 | `--json`으로 후속 자동화가 쉬운 구조화 데이터를 출력합니다. |
| 결과 파일 저장 | `--output-file`로 read 결과를 파일에 저장합니다. |
| 메시지 작성/전송 | `write`로 Teams compose box에 메시지를 입력하고 전송합니다. |
| 전송 전 미리보기 | `write --no-send`로 입력만 하고 보내지 않을 수 있습니다. |
| 공유 파일 목록 확인 | `files`로 채팅 내 파일 링크를 수집합니다. |
| 공유 파일 열기 | `files --open`으로 파일 링크를 새 탭에서 엽니다. |
| 공유 파일 다운로드 | `files --download`로 다운로드를 시도합니다. |

## 전달할 때 이 파일만 있으면 되는가?

상황에 따라 다릅니다.

| 전달 대상 | 필요한 파일 |
|---|---|
| 사람이 직접 CLI로 실행 | `tools/teams/teams_chat_rw.py`와 이 매뉴얼이면 충분합니다. |
| 다른 repo/PC에서 재사용 | `teams_chat_rw.py`, 이 매뉴얼, 실행 환경 안내가 필요합니다. |
| Claude/Codex 같은 agent가 자연어 요청으로 실행 | `teams_chat_rw.py`와 함께 `SKILL.md`도 전달하는 것이 좋습니다. |

`SKILL.md`는 런타임 필수 파일이 아닙니다. Python script가 실행될 때 `SKILL.md`를 import하거나 읽지 않습니다.

다만 `SKILL.md`는 AI agent에게 "Teams 채팅 요청이 오면 이 스크립트를 이렇게 호출하라"는 사용법을 알려주는 instruction 파일입니다. 사람이 명령어를 직접 입력한다면 없어도 되고, agent 기반 workflow로 배포하려면 같이 전달하는 편이 좋습니다.

## 실행 전 준비물

1. Python 3.10 이상
2. Chrome 또는 Edge
3. Selenium
4. 접근 권한이 있는 Teams 계정
5. 대상 Teams chat URL
6. 첫 실행 시 interactive login

Selenium을 별도로 설치하지 않았다면 다음처럼 실행할 수 있습니다.

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py read --limit 5
```

또는 환경에 설치:

```bash
pip install selenium
```

## 사람들이 바꿔서 써야 하는 부분

### 1. 대상 채팅 URL

가장 중요합니다.

현재 코드는 `TEAMS_CHAT_URL` 환경 변수 또는 `--chat-url` 인자로 대상 채팅을 받습니다. 개인 Teams thread id를 코드에 넣지 말고 `.env`에 보관하는 것이 좋습니다.

권장 방식:

```bash
export TEAMS_CHAT_URL='https://teams.microsoft.com/l/chat/<CHAT_THREAD_ID>/conversations?context=...'
```

또는 실행할 때 직접 전달:

```bash
python3 tools/teams/teams_chat_rw.py read \
  --chat-url 'https://teams.microsoft.com/l/chat/<CHAT_THREAD_ID>/conversations?context=...' \
  --limit 10
```

### 2. 로그인 profile 경로

기본값:

```text
~/.cache/teams-chat-rw/chrome-profile
```

여러 계정이나 여러 채팅 자동화를 분리하려면 profile을 따로 지정합니다.

```bash
python3 tools/teams/teams_chat_rw.py login \
  --profile-dir ~/.cache/teams-chat-rw/my-team-profile \
  --login-wait 300
```

이후 같은 profile로 실행해야 같은 로그인 세션을 재사용합니다.

### 3. 작성자 alias

Teams DOM에는 이메일이 아니라 표시 이름이 나오는 경우가 많습니다.

```bash
export TEAMS_AUTHOR_ALIASES='user@example.com=Display Name|Korean Name'
```

또는 실행 시:

```bash
--author-alias 'user@example.com=Display Name|Korean Name'
```

### 4. 브라우저 선택

기본은 자동 선택입니다. 필요하면 명시합니다.

```bash
--browser chrome
--browser edge
```

브라우저 binary 경로가 특수하면:

```bash
export TEAMS_BROWSER_BINARY='/path/to/browser'
```

### 5. 다운로드 경로

기본값:

```text
./teams_downloads
```

변경:

```bash
export TEAMS_DOWNLOAD_DIR='./downloads'
```

또는:

```bash
--download-dir ./downloads
```

### 6. timeout/headless/debug 옵션

네트워크가 느리거나 Teams UI 로딩이 오래 걸리면:

```bash
--timeout 180
```

실패 시 화면 캡처를 남기려면:

```bash
--debug-dir ./teams_debug
```

`--headless`는 로그인/MFA/일부 Teams UI에서 불안정할 수 있으므로, 처음 로그인할 때는 visible browser로 실행하는 것이 좋습니다.

### 7. 고급 수정 지점

일반 사용자는 아래를 바꿀 필요가 없습니다.

| 코드 영역 | 언제 수정하는가 |
|---|---|
| `EXTRACT_CHAT_ITEMS_JS` | Teams 메시지 DOM 구조가 바뀌어 read가 실패할 때 |
| `EXTRACT_VISIBLE_FILES_JS` | 파일 링크 탐지가 누락될 때 |
| `FIND_COMPOSE_JS` | compose box를 못 찾을 때 |
| `FIND_SEND_BUTTON_JS` | send 버튼을 못 찾을 때 |
| `isFileLike()`의 확장자 regex | 특정 확장자를 파일로 인식시키고 싶을 때 |

## 공유 전에 지워야 하거나 바꿔야 하는 개인 정보

### 반드시 확인할 것

| 위치 | 현재 의미 | 공유 전 조치 |
|---|---|---|
| `.env`의 `TEAMS_CHAT_URL` | 특정 Teams chat deep link/thread id | 외부 공유 금지 |
| `TEAMS_CHAT_URL` 환경 변수 | 실제 대상 채팅 URL | 문서/스크린샷/쉘 히스토리에 노출되지 않게 주의 |
| `TEAMS_AUTHOR_ALIASES` 환경 변수 | 이메일과 표시 이름 mapping | 예시는 `user@example.com` 형태로 익명화 |
| `--author-alias` 예시 | 개인 이메일/이름 포함 가능 | 공유 문서에서는 익명화 |
| `--message`, `--message-file` 내용 | 실제 전송 메시지 | 민감 내용 포함 여부 확인 |
| `--output-file` 결과물 | 채팅 본문/작성자/파일 링크 포함 | 외부 전달 전 내용 검토 |
| `--debug-dir` 결과물 | Teams URL, title, screenshot 저장 | 외부 전달 금지 또는 마스킹 |
| 다운로드 폴더 | Teams/SharePoint 파일 원본 | 외부 전달 전 보안 검토 |

### 절대 같이 전달하면 안 되는 것

기본 browser profile directory:

```text
~/.cache/teams-chat-rw/chrome-profile
```

이 디렉터리에는 Teams 로그인 세션, 쿠키, 캐시, 계정 관련 데이터가 들어갈 수 있습니다. `teams_chat_rw.py`를 전달할 때 이 profile directory를 압축해서 보내면 안 됩니다.

### 코드 안 auth 관련 설명

이 스크립트에는 Microsoft password, access token, refresh token 같은 값을 하드코딩하지 않습니다. 인증은 Selenium이 사용하는 브라우저 profile에 저장된 Teams Web 로그인 세션을 재사용합니다.

단, `GET_CURRENT_USER_PROFILE_JS`는 author filtering을 돕기 위해 Teams Web의 localStorage/sessionStorage에서 현재 사용자 표시 이름 또는 UPN 같은 profile 정보를 읽으려고 시도합니다. 이 값은 출력하지 않고 author alias 판단에만 사용됩니다.

## `SKILL.md`를 같이 전달할 때 지울 부분

`SKILL.md`를 agent workflow용으로 같이 전달한다면, 아래 예시 값들은 반드시 일반화하세요.

| 항목 | 조치 |
|---|---|
| 개인 이메일 예시 | `user@example.com` 같은 placeholder로 변경 |
| 개인 이름/한글 이름 alias | `Display Name|Korean Name` 같은 placeholder로 변경 |
| 특정 조직/팀만 아는 표현 | 범용 설명으로 변경 |
| 실제 chat URL이 들어간 경우 | 제거하고 `TEAMS_CHAT_URL` 사용 안내로 대체 |

`SKILL.md`는 편의를 위한 agent instruction이므로, 일반 사용자에게는 이 매뉴얼의 명령어 예시만 있어도 충분합니다.

## 보안상 권장 배포 형태

가장 안전한 전달 방식은 다음과 같습니다.

1. 개인 Teams URL이 코드에 없는 `teams_chat_rw.py` 전달
2. 이 매뉴얼 전달
3. 각 사용자가 자신의 PC에서 직접 `login` 실행
4. 각 사용자가 자신의 shell에서 `TEAMS_CHAT_URL` 설정
5. browser profile directory, debug screenshot, 다운로드 파일, 출력 파일은 전달하지 않음

## 제한 사항

| 제한 | 설명 |
|---|---|
| Graph API가 아님 | 공식 API가 아니라 Teams Web UI 자동화입니다. |
| UI 변경에 취약 | Teams DOM selector가 바뀌면 일부 기능이 실패할 수 있습니다. |
| 전체 히스토리 보장 아님 | 화면에 로드된 메시지 중심으로 읽습니다. |
| 로그인 필요 | 각 사용자가 접근 권한이 있는 계정으로 직접 로그인해야 합니다. |
| MFA/headless 제약 | MFA가 필요한 경우 headless 실행은 부적합할 수 있습니다. |
| 전송은 실제 전송 | `write`는 실제 채팅에 메시지를 보냅니다. 테스트 시 `--no-send`를 먼저 쓰는 것을 권장합니다. |
| 파일 다운로드 권한 의존 | SharePoint/OneDrive 권한과 브라우저 세션 상태에 따라 다운로드 성공 여부가 달라집니다. |

## 추천 사용 순서

새 PC 또는 새 사용자 기준:

```bash
export TEAMS_CHAT_URL='https://teams.microsoft.com/l/chat/<CHAT_THREAD_ID>/conversations?context=...'

uv run --with selenium python3 tools/teams/teams_chat_rw.py login --login-wait 300

uv run --with selenium python3 tools/teams/teams_chat_rw.py read --limit 5

uv run --with selenium python3 tools/teams/teams_chat_rw.py write \
  --message "테스트 메시지입니다." \
  --no-send
```

`--no-send`로 올바른 채팅방과 compose box가 확인되면 실제 전송을 시도합니다.

```bash
uv run --with selenium python3 tools/teams/teams_chat_rw.py write \
  --message "테스트 메시지입니다."
```

## 다른 사람에게 설명할 때 짧은 버전

이 도구는 Graph API 권한 없이 Teams Web을 Selenium으로 조작하는 자동화 스크립트입니다. 각 사용자가 자기 PC에서 한 번 Teams에 로그인하면, 그 브라우저 profile을 재사용해서 채팅 읽기, 메시지 보내기, 공유 파일 링크 확인/다운로드를 할 수 있습니다.

스크립트 파일만으로 실행은 가능하지만, 대상 채팅 URL과 로그인 session은 각 사용자가 따로 준비해야 합니다. AI agent가 자연어로 이 도구를 쓰게 하려면 `SKILL.md`도 같이 전달하는 것이 좋고, 그 안의 개인 이메일/이름 예시는 익명화해야 합니다. 공유 전에는 `DEFAULT_CHAT_URL`과 browser profile directory, debug/output/download 결과물을 특히 조심해야 합니다.
