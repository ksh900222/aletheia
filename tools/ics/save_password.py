#!/usr/bin/env python3
"""ICS SSO 비밀번호를 Windows Credential Manager에 저장합니다. (최초 1회 실행)"""
import getpass
import sys

try:
    import keyring
except ImportError:
    print("keyring 패키지가 없습니다. setup_uv.bat 또는 setup_pip.bat 을 먼저 실행하세요.")
    sys.exit(1)

print("=== ICS SSO 비밀번호 저장 ===")
print("입력한 비밀번호는 Windows Credential Manager에 저장되며, 이 스크립트에는 남지 않습니다.")
print()

sso_id = input("SSO ID (사번, 예: yhchoi20): ").strip()
if not sso_id:
    print("SSO ID가 비어있습니다.")
    sys.exit(1)

pw = getpass.getpass("ICS SSO 비밀번호 (입력해도 화면에 표시되지 않음): ")
if not pw:
    print("비밀번호가 비어있습니다.")
    sys.exit(1)

keyring.set_password("ICS_SSO", sso_id, pw)

stored = keyring.get_password("ICS_SSO", sso_id)
if stored == pw:
    print(f"저장 완료! (ID: {sso_id}, 길이: {len(pw)})")
    print()
    print(f"실행 명령어 예시:")
    print(f"  uv: .venv\\Scripts\\python.exe ICS_send_PW_v7.py --sso-id {sso_id} --teams-user {sso_id}@lginnotek.com --browser edge --send-delay 20 --teams-ready-timeout 60")
    print(f"  pip: python ICS_send_PW_v7.py --sso-id {sso_id} --teams-user {sso_id}@lginnotek.com --browser edge --send-delay 20 --teams-ready-timeout 60")
else:
    print("저장 실패. Windows Credential Manager를 확인하세요.")
    sys.exit(1)
