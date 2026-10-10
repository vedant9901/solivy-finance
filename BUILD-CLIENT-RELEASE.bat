@echo off
setlocal
cd /d "%~dp0"
echo.
echo ================================================
echo   SOLIVY FINANCE - BUILD CLIENT RELEASE
echo ================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-CLIENT-RELEASE.ps1"
if errorlevel 1 (
  echo.
  echo RELEASE BUILD FAILED. Review the error above.
  pause
  exit /b 1
)
echo.
echo Release ZIP created in the releases folder.
pause
