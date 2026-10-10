@echo off
setlocal
set "CONFIG=%APPDATA%\SOLIVY-FINANCE\server.pid"
if not exist "%CONFIG%" (
  echo SOLIVY Finance is not running, or its process file was not found.
  pause
  exit /b 0
)
for /f %%P in (%CONFIG%) do taskkill /PID %%P /T /F >nul 2>&1
 del "%CONFIG%" >nul 2>&1
echo SOLIVY Finance stopped.
pause
