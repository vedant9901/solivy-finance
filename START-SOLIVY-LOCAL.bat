@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo SOLIVY is not installed yet. Run INSTALL-SOLIVY-LOCAL.bat first.
  pause
  exit /b 1
)
if not exist .next (
  echo Production build not found. Building now...
  call npm run build
  if errorlevel 1 pause & exit /b 1
)
start "SOLIVY Finance" cmd /c "npm start"
timeout /t 3 /nobreak >nul
start "" http://localhost:3000
