@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === ICS 비밀번호 전송 (pip 버전) ===
echo.

set /p SSO_ID="SSO ID (사번, 예: yhchoi20): "
set /p TEAMS_EMAIL="Teams 이메일 (예: 사번@lginnotek.com): "

echo.
echo 실행 중...
python ICS_send_PW_v7.py --sso-id %SSO_ID% --teams-user %TEAMS_EMAIL% --browser edge --send-delay 20 --teams-ready-timeout 60

echo.
pause
