@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === ICS 도구 설치 (pip 버전) ===
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo Python이 설치되어 있지 않습니다.
    echo https://www.python.org/downloads/ 에서 설치 후 재실행하세요.
    echo 설치 시 "Add Python to PATH" 옵션을 반드시 체크하세요.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [1/3] %%i 확인

echo.
echo [2/3] 패키지 설치 중 (pip)...
python -m pip install --upgrade pip --quiet --trusted-host pypi.org --trusted-host files.pythonhosted.org
python -m pip install -r requirements_windows.txt --trusted-host pypi.org --trusted-host files.pythonhosted.org
if errorlevel 1 (
    echo pip install 실패.
    pause
    exit /b 1
)

echo.
echo [3/3] SSO 비밀번호 저장...
python save_password.py
if errorlevel 1 (
    echo 비밀번호 저장 중 오류 발생.
    pause
    exit /b 1
)

echo.
echo 설치 완료! run_pip.bat 을 실행하세요.
pause
