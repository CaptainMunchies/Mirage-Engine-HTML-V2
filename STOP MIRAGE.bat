@echo off
setlocal EnableDelayedExpansion
title Mirage Engine - Stop
cd /d "%~dp0"

echo.
echo   Mirage Engine - stopping
echo.

set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080" ^| findstr "LISTENING"') do call :stopOne %%a

if not defined FOUND echo   Mirage was not running.

echo.
timeout /t 2 /nobreak >nul
exit /b 0


:: Stop the holder of port 8080 only when it is actually Mirage. This script
:: used to taskkill whoever owned the port, Mirage or not.
:stopOne
set "FOUND=1"
call :isMirage %1
if errorlevel 1 goto :stopForeign
taskkill /PID %1 /F >nul 2>&1
echo   Mirage server stopped ^(PID %1^).
exit /b 0
:stopForeign
echo   [!] Port 8080 is held by PID %1, which is not Mirage - leaving it alone.
exit /b 0

:: Is this PID our own server? Checks the command line rather than assuming
:: whatever holds port 8080 belongs to Mirage.
:isMirage
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + %1) -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*mirage_server.py*') { exit 0 } else { exit 1 }" >nul 2>&1
exit /b %errorlevel%
