@echo off
setlocal
cd /d "%~dp0"
rem Forward optional launcher flags so package checks can use the real startup flow without opening a browser.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\start.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the environment report above.
  pause
)
endlocal
