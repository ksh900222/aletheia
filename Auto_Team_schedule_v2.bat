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

python C:\Users\shkim4480\PycharmProjects\budget_control\EP_TEAM_ScheduleChecker_v0.py --fresh-login
