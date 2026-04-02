@echo off
REM Optional: the main MT5RemoteAgent.exe now opens a pairing GUI on first run.
title MT5 Remote Agent - pairing (optional)
cd /d "%~dp0"
echo.
echo Enter the pairing code from your panel admin (Remote devices), then press Enter.
set /p PAIRING_CODE=Pairing code: 
if "%PAIRING_CODE%"=="" (
  echo No code entered.
  pause
  exit /b 1
)
echo.
MT5RemoteAgent.exe
echo.
pause
