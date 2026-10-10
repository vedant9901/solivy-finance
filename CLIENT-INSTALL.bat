@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0CLIENT-INSTALL.ps1"
if errorlevel 1 (
  echo.
  echo SOLIVY FINANCE INSTALLATION FAILED. See error above.
  pause
  exit /b 1
)
pause
