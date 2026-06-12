@echo off
rem Workloop launcher for Windows — double-click me.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found. Install Node 18+ from https://nodejs.org and run me again.
  echo.
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=4317
start "" /min cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"
echo.
echo   Starting Workloop on http://localhost:%PORT%  (close this window to stop)
echo.
node server.mjs
pause
