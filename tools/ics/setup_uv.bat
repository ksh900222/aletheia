@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === ICS 도구 설치 (uv 버전) ===
echo.

where uv >nul 2>&1
if errorlevel 1 (
    echo [1/3] uv 설치 중...
    winget install --id=astral-sh.uv -e
    if errorlevel 1 (
        echo.
        echo uv 설치 실패.
        echo 직접 설치: https://docs.astral.sh/uv/getting-started/installation/
        pause
        exit /b 1
    )
    echo uv 설치 완료.
) else (
    echo [1/3] uv 이미 설치되어 있음
)

echo.
echo [2/3] 패키지 설치 중 (uv sync)...
uv sync --allow-insecure-host pypi.org --allow-insecure-host files.pythonhosted.org
if errorlevel 1 (
    echo uv sync 실패.
    pause
    exit /b 1
)

echo.
echo [3/3] SSO 비밀번호 저장...
.venv\Scripts\python.exe save_password.py
if errorlevel 1 (
    echo 비밀번호 저장 중 오류 발생.
    pause
    exit /b 1
)

echo.
echo 설치 완료! run.bat 을 실행하세요.
pause
