# ICS Teams Chat 자동화 작업 기록

이 문서는 ICS password를 Teams self-chat으로 전달하고, Linux에서 다시 읽어오는 자동화 작업의 실패 지점, 디버깅 과정, 최종 성공 경로를 정리한 기록입니다. 민감값은 포함하지 않습니다.

## 목표

1. Windows에서 ICS에 로그인해 `icsPwd` cookie/password를 crawling한다.
2. Graph API 권한이나 Teams Workflows 없이 Teams self-chat에 password를 쓴다.
3. Linux에서 Teams self-chat의 최신 메시지를 읽어 password text로 저장한다.

## 제약 조건

- Microsoft Graph 권한 없음.
- Teams Workflows 메뉴가 보이지 않음. 조직 정책 또는 Teams app permission policy 영향 가능성이 있음.
- 최종 write 경로는 Windows GUI Teams Web/Browser UI 자동화.
- 최종 read 경로는 Linux Selenium + Teams Web DOM crawling.
- 민감값은 git에 포함하지 않음. 결과 파일은 `tools/ics/auth/` 아래 저장하며 `.gitignore` 대상이다.

## 실패 및 디버깅 기록

### 1. Graph API / Workflows 경로

처음에는 Graph API 대신 Teams Workflows webhook을 검토했다. 하지만 Teams 채팅 메뉴의 `...`에서 Workflows가 보이지 않았고, Teams 앱 검색/조직 정책 가능성이 있었다. 따라서 webhook URL 생성이 막혀 Workflows 방식은 중단했다.

결론:

- Graph API는 권한이 필요해 제외.
- Workflows는 조직 설정에 의해 막혀 있을 수 있어 제외.
- UI 자동화 방식으로 전환.

### 2. Teams deep link 입력

Teams deep link의 `message=` parameter를 이용해 self-chat 입력창에 test message를 넣는 것까지 성공했다.

예시:

```text
https://teams.microsoft.com/l/chat/0/0?users=<user>&message=<encoded-message>
```

문제:

- 입력창에 값이 보이더라도 Send button 자동 클릭이 필요했다.
- deep link의 `message=`가 항상 Teams compose box에 안정적으로 들어가는 것은 아니었다.
- 실제 password 전송 시 브라우저 히스토리에 message가 남을 수 있어 위험했다.

### 3. Linux/X11 Send 자동화

Linux 환경에는 `xdotool`이 없었다. `/tmp/aletheia-xdotool` 아래 Debian package를 임시 download/unpack해서 사용했다.

성공:

- test message 자동 send는 가능했다.

한계:

- Windows 실행 환경에서는 X11/xdotool 경로를 사용할 수 없었다.
- 실제 최종 실행은 Windows에서 해야 했으므로 별도 Windows version이 필요했다.

### 4. Windows `ICS_send_PW_v2` 계열

Windows에서는 `.venv`의 Python을 직접 실행해야 했다.

정상 실행 형태:

```bat
cd /d C:\Python_scripts\ICS
.venv\Scripts\python.exe ICS_send_PW_v7.py --sso-id your-sso-id --teams-user your.name@example.com --browser edge --send-delay 20 --teams-ready-timeout 60
```

중간 실패:

- `python` 명령이 PATH에서 정상 Python이 아니라 `Python`만 출력하는 launcher/alias처럼 동작했다.
- `uv`도 PATH에 없어 `uv run`이 실패했다.
- 해결은 `.venv\Scripts\python.exe`를 직접 실행하는 것이었다.

### 5. Windows keyring 문제

처음에는 `keyring` module이 없었다.

해결:

```bat
cd /d C:\Python_scripts\ICS
.venv\Scripts\python.exe -m ensurepip --upgrade
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install keyring
```

keyring backend 확인:

```bat
.venv\Scripts\python.exe -c "import keyring; print(keyring.get_keyring())"
```

정상 예시:

```text
keyring.backends.Windows.WinVaultKeyring (priority: 5)
```

비밀번호 저장:

```bat
.venv\Scripts\python.exe -c "import keyring, getpass; keyring.set_password('ICS_SSO', 'your-sso-id', getpass.getpass('ICS SSO Password: ')); print('saved')"
```

확인:

```bat
.venv\Scripts\python.exe -c "import keyring; pw = keyring.get_password('ICS_SSO', 'your-sso-id'); print('found' if pw else 'missing'); print(len(pw) if pw else 0)"
```

### 6. ICS crawling 불안정

관찰된 오류:

```text
TimeoutError: Cookie 'icsPwd' not found within 5.0 seconds.
selenium.common.exceptions.WebDriverException: net::ERR_CONNECTION_REFUSED
```

판단:

- keyring/password 문제는 아니었다.
- 한 번은 정상 crawling이 성공했기 때문에 코드 전체 실패가 아니었다.
- `ERR_CONNECTION_REFUSED`는 `${ICS_BASE_URL}` 접속 자체가 거절된 상태로, 사내망/VPN/서버/포트 상태 문제 가능성이 높다.
- `icsPwd not found`는 SSO 전환 지연 또는 실패를 기존 코드가 충분히 기다리지 못한 문제였다.

대응:

- cookie wait 기본값 증가.
- ICS SSO URL retry 추가.
- login button click 후 wait 추가.
- 실패 시 debug screenshot/meta 저장 옵션 추가.

관련 옵션:

```bat
--cookie-timeout 60 --login-wait 5 --ics-retries 5 --ics-retry-delay 5 --debug-dir debug_ics
```

### 7. Teams Send 실패

초기 Windows Send 방식은 다음 둘 중 하나였다.

- PowerShell `SendKeys`
- UI Automation으로 Send button 탐색 후 click

실패 양상:

- `Sent ICS password to Teams chat`가 출력됐지만 실제로는 compose box에 남아 있었다.
- Send button 대신 Teams 화면 안의 file 영역이 클릭되기도 했다.
- `--send-method button`은 Send button을 못 찾거나 엉뚱한 요소를 클릭할 수 있었다.

원인:

- Teams Web deep link의 `message=`가 compose box에 안정적으로 들어가지 않았다.
- UI Automation tree에서 Teams Send button 이름이 안정적으로 노출되지 않았다.
- paste 후 Python으로 돌아와 다시 창을 활성화하면 compose focus가 빠질 수 있었다.

최종 대응:

- deep link `message=` 의존 제거.
- Windows clipboard에 password 저장.
- Teams self-chat deep link는 chat open 용도로만 사용.
- 같은 PowerShell/UIAutomation 흐름에서 compose click -> paste -> send key sequence를 연속 실행.
- 최종 성공 파일: `ICS_send_PW_v7.py`

최종 Windows 실행:

```bat
cd /d C:\Python_scripts\ICS
.venv\Scripts\python.exe ICS_send_PW_v7.py --sso-id your-sso-id --teams-user your.name@example.com --browser edge --send-delay 20 --teams-ready-timeout 60
```

## 최종 Write 성공 경로

최종 성공 script:

```text
ICS_send_PW_v7.py
```

주요 동작:

1. Windows keyring에서 `ICS_SSO / your-sso-id` password를 읽는다.
2. Selenium Edge로 portal 로그인 후 ICS SSO URL에 접근한다.
3. `icsPwd` cookie value를 얻는다.
4. Teams self-chat을 deep link로 연다.
5. Windows clipboard에 password를 넣는다.
6. Teams compose box에 paste한다.
7. paste 직후 같은 UIAutomation 흐름에서 send key sequence를 실행한다.

성공 로그 예시:

```text
ICS password crawled. length=10
Pasted ICS password and sent Teams key sequence.
```

## 최종 Read 성공 경로

최종 성공 script:

```text
ICS_read_PW_v1.py
```

실행 경로:

```bash
cd ~/workspace/aletheia/tools/ics
```

필요 패키지는 `tools/ics` uv 환경에 이미 포함되어 있었다.

확인:

```bash
uv run python - <<'PY'
import importlib.util
for name in ['selenium', 'bs4', 'lxml']:
    print(f'{name}={bool(importlib.util.find_spec(name))}')
PY
```

성공한 read 명령:

```bash
uv run python ../../ICS_read_PW_v1.py \
  --teams-user your.name@example.com \
  --timeout 60 \
  --stable-polls 1 \
  --output-file auth/teams_latest_ics_password.txt \
  --debug-dir debug/teams_read_strict
```

저장 위치:

```text
tools/ics/auth/teams_latest_ics_password.txt
```

저장 파일 권한:

```text
600
```

이 파일은 `.gitignore`의 `tools/ics/auth/` 규칙으로 git 추적 대상이 아니다.

### Read 디버깅

처음에는 Teams DOM에서 실제 메시지가 아니라 UI accessibility text인 아래 문자열을 읽었다.

```text
has context menu
```

대응:

- `has context menu`, `context menu`, `more options`, `reaction`, `reply`, `copy`, `delete` 등 UI text를 reject list에 추가했다.
- 기본적으로 password regex에 맞는 최신 visible message만 선택하도록 변경했다.

기본 regex:

```text
^\S{4,200}$
```

결과:

- 최신 Teams message에서 password 형태의 text를 정상 추출했다.
- 출력 및 저장 성공.

## Chrome / Firefox 지원 상태

현재 read script는 Chrome/Edge만 지원한다.

```text
--browser {auto,chrome,edge}
```

Firefox는 미지원이다. 이유:

- Selenium Firefox는 `geckodriver`와 Firefox profile handling이 별도로 필요하다.
- 현재 Linux Firefox는 snap package로 실행 중이며 Selenium/profile 권한 이슈가 발생할 가능성이 높다.
- Chrome profile 방식으로 이미 성공했으므로 안정성 측면에서 Chrome 유지가 권장된다.

## 현재 권장 명령 모음

### Windows: ICS password를 Teams로 write

```bat
cd /d C:\Python_scripts\ICS
.venv\Scripts\python.exe ICS_send_PW_v7.py --sso-id your-sso-id --teams-user your.name@example.com --browser edge --send-delay 20 --teams-ready-timeout 60
```

### Linux: Teams 최신 password message를 read

```bash
cd ~/workspace/aletheia/tools/ics
uv run python ../../ICS_read_PW_v1.py \
  --teams-user your.name@example.com \
  --timeout 60 \
  --stable-polls 1 \
  --output-file auth/teams_latest_ics_password.txt \
  --debug-dir debug/teams_read_strict
```

### 저장 결과 확인

민감값을 직접 출력하지 않고 길이와 권한만 확인한다.

```bash
stat -c '%a %n' auth/teams_latest_ics_password.txt
wc -c < auth/teams_latest_ics_password.txt
```

## 남은 주의사항

- Teams UI 자동화는 Teams Web DOM/접근성 구조 변경에 영향을 받을 수 있다.
- Graph API 또는 공식 bot/webhook 권한이 생기면 UI 자동화보다 공식 API 방식이 안정적이다.
- Windows write script는 GUI 세션과 로그인된 Teams/Edge 상태가 필요하다.
- Linux read script는 persistent Chrome profile의 Teams login session에 의존한다.
- password 값은 Teams chat history와 로컬 `auth/` 파일에 남으므로 접근 권한 관리가 필요하다.
