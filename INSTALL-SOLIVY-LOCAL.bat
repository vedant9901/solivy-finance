@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL-SOLIVY-LOCAL.ps1"
if errorlevel 1 (
  echo.
  echo INSTALLATION FAILED. Review the error above.
  pause
  exit /b 1
)
pause
