@echo off
chcp 65001 >nul
call C:\Users\shkim4480\PycharmProjects\budget_control\.venv\Scripts\activate.bat
cd /d "%~dp0"

REM === 한국시간(KST) 기준 주말 및 한국 법정공휴일(대체공휴일 포함)이면 종료 ===
REM exit 0: 영업일 (메인 스크립트 실행)
REM exit 1: 주말 또는 공휴일 (스킵)
python -c "import sys, datetime, holidays; from zoneinfo import ZoneInfo; d=datetime.datetime.now(ZoneInfo('Asia/Seoul')).date(); sys.exit(1 if (d.weekday()>=5 or d in holidays.KR(years=d.year)) else 0)"
if errorlevel 1 (
    echo [SKIP] %date% %time% : weekend or KR holiday. Main script not executed.
    exit /b 0
)

REM === 이전 실행에서 남은 잔여 브라우저 프로세스 정리 ===
REM 좀비 chrome.exe 가 --user-data-dir 프로필을 잠그면 새 세션이
REM DevToolsActivePort 오류로 즉시 크래시한다. 실행 전에 정리한다.
echo [*] 잔여 chrome / chromedriver 프로세스 정리...
taskkill /F /IM chromedriver.exe >nul 2>&1
taskkill /F /IM chrome.exe >nul 2>&1

REM 프로세스가 핸들을 완전히 놓을 때까지 잠깐 대기
ping -n 3 127.0.0.1 >nul

python C:\Users\shkim4480\PycharmProjects\budget_control\EP_TEAM_ScheduleChecker_v0.py --fresh-login
