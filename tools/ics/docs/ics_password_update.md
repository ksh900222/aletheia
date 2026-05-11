# ICS Credential Manager 비밀번호 갱신 방법

ICS(${ICS_BASE_URL}) 자동화 스크립트에서 사용하는 SSO 비밀번호가 변경되었을 때, Credential Manager에 새 비밀번호를 저장하는 방법입니다.

## 권장 실행 경로

Windows/Git Bash에서 실행 경로가 `C:/python_scripts`이고, 그 안의 `.venv` 가상환경을 써야 한다면 아래 방식을 권장합니다.

```bash
cd /c/python_scripts

# .venv가 없을 때만 1회 생성
test -d .venv || uv venv .venv

# Git Bash 기준 .venv 활성화
source .venv/Scripts/activate

# .venv 안에 keyring이 없을 때만 1회 설치
uv pip install keyring

# uv가 활성화된 .venv를 쓰도록 --active를 붙여 실행
uv run --active python -c "import keyring, getpass; keyring.set_password('ICS_SSO', 'your-sso-id', getpass.getpass('Password: '))"
```

저장 확인:

```bash
cd /c/python_scripts
source .venv/Scripts/activate
uv run --active python -c "import keyring; pw = keyring.get_password('ICS_SSO', 'your-sso-id'); print(f'길이: {len(pw) if pw else 0}')"
```

- 프롬프트에 `Password:`가 뜨면 **새 비밀번호를 직접 타이핑**
- 비밀번호 길이가 실제와 일치하면 정상
- `.env`의 ICS_ID 값이 바뀌면 위 명령의 `'your-sso-id'` 부분도 동일하게 변경
- `uv run --active`는 현재 활성화된 `.venv`를 우선 사용하게 하는 옵션입니다.

## 권장 실행 경로에서 keyring 환경 확인

```bash
cd /c/python_scripts
source .venv/Scripts/activate
uv run --active python -c "import keyring; print(keyring.get_keyring())"
```

저장/조회/delete까지 확인하려면 아래 임시 테스트를 실행합니다. 실제 ICS 비밀번호와 무관한 테스트 값이며, 마지막에 삭제됩니다.

```bash
cd /c/python_scripts
source .venv/Scripts/activate
uv run --active python - <<'PY'
import keyring
service = 'ICS_SSO_SMOKE_TEST'
user = 'keyring-check'
value = 'temporary-test-value'
keyring.set_password(service, user, value)
print('write/read ok:', keyring.get_password(service, user) == value)
keyring.delete_password(service, user)
print('delete ok:', keyring.get_password(service, user) is None)
PY
```

정상 예시:

```text
write/read ok: True
delete ok: True
```

## 자주 나는 오류: 다른 경로에서 실행

아래처럼 repo root(`~/workspace/aletheia`)나 `.venv`가 없는 경로에서 실행하면 `keyring`을 못 찾을 수 있습니다.

```bash
uv run python -c "import keyring"
```

오류 예시:

```text
ModuleNotFoundError: No module named 'keyring'
```

해결: `C:/python_scripts`로 이동하고 `.venv`를 활성화한 뒤 `uv run --active`로 실행합니다.

## Linux 서버에서 tools/ics uv 프로젝트를 쓰는 경우

`keyring`은 `tools/ics` uv 프로젝트 의존성에도 포함되어 있습니다. Linux 서버에서 repo 안의 프로젝트 환경을 그대로 쓸 때는 아래처럼 실행합니다.

```bash
cd ~/workspace/aletheia/tools/ics
uv run python -c "import keyring; print(keyring.get_keyring())"
```

정상 예시:

```text
keyring.backends.SecretService.Keyring (priority: 5)
```

비밀번호 저장:

```bash
cd ~/workspace/aletheia/tools/ics
uv run python -c "import keyring, getpass; keyring.set_password('ICS_SSO', 'your-sso-id', getpass.getpass('Password: '))"
```

- 프롬프트에 `Password:`가 뜨면 **새 비밀번호를 직접 타이핑**
- 입력 후 엔터

저장 확인:

```bash
cd ~/workspace/aletheia/tools/ics
uv run python -c "import keyring; pw = keyring.get_password('ICS_SSO', 'your-sso-id'); print(f'길이: {len(pw) if pw else 0}')"
```

- 비밀번호 길이가 실제와 일치하면 정상

## Linux SecretService 오류 시

`No recommended backend`, `SecretService`, `DBus`, `collection is locked` 류 오류가 나오면 Python 패키지 문제가 아니라 Linux keyring backend 문제입니다.

```bash
sudo apt install gnome-keyring libsecret-tools
```

그 다음 GUI 로그인 세션에서 다시 실행합니다. 서버/SSH 환경에서는 사용자 세션의 Secret Service가 잠겨 있으면 저장이 실패할 수 있습니다.

## Windows PowerShell에서 직접 실행하는 경우

```powershell
cd C:\python_scripts
.\.venv\Scripts\Activate.ps1
uv pip install keyring
uv run --active python -c "import keyring, getpass; keyring.set_password('ICS_SSO', 'your-sso-id', getpass.getpass('Password: '))"
```

저장 확인:

```powershell
cd C:\python_scripts
.\.venv\Scripts\Activate.ps1
uv run --active python -c "import keyring; pw = keyring.get_password('ICS_SSO', 'your-sso-id'); print(f'길이: {len(pw) if pw else 0}')"
```

만약 `uv`를 쓰지 않는 일반 Python 환경에서만 실행해야 한다면:

```powershell
python -c "import keyring, getpass; keyring.set_password('ICS_SSO', 'your-sso-id', getpass.getpass('Password: '))"
```

cmd.exe를 써야 한다면 활성화 명령만 아래처럼 바꿉니다.

```bat
cd C:\python_scripts
.venv\Scripts\activate.bat
uv pip install keyring
uv run --active python -c "import keyring, getpass; keyring.set_password('ICS_SSO', 'your-sso-id', getpass.getpass('Password: '))"
```

## 세션 만료/로그인 실패 시
- `auth/state.json` 삭제 후 재실행

```powershell
Remove-Item d:\_2026\18_ICS\auth\state.json -ErrorAction SilentlyContinue
```

---
- 비밀번호는 절대 .env, 코드, 프롬프트에 직접 입력하지 않음
