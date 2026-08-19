@echo off
setlocal EnableDelayedExpansion
title Mirage Engine
cd /d "%~dp0"

echo.
echo   Mirage Engine
echo   -------------
echo.

:: ------------------------------------------------------------------
:: 1. Find a usable Python.
::    This used to be a hardcoded "py -3.11". On any other version the
::    server died instantly inside a minimised window, and the browser
::    then opened a dead port with nothing on screen explaining why.
::    The probe lives in a subroutine because its parentheses would
::    otherwise be swallowed by a parenthesised for-body.
:: ------------------------------------------------------------------
set "PYEXE="
for %%P in ("py -3" "python" "python3" "py") do call :tryPy %%P

if not defined PYEXE (
    echo   [X] No usable Python 3.8+ was found on this machine.
    echo.
    echo       Mirage needs Python to run its local server. Install it from
    echo       https://www.python.org/downloads/ and tick "Add python.exe to PATH"
    echo       during setup, then run this file again.
    echo.
    pause
    exit /b 1
)
echo   Python: %PYEXE%  ^(%PYVER%^)

:: ------------------------------------------------------------------
:: 2. Free port 8080 - but only if the process holding it is ours.
::    This used to taskkill whoever owned the port, which happily took
::    down an unrelated dev server.
:: ------------------------------------------------------------------
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080" ^| findstr "LISTENING"') do call :freePort %%a
if errorlevel 1 exit /b 1

:: ------------------------------------------------------------------
:: 3. Start the server, keeping its output so a crash is readable.
:: ------------------------------------------------------------------
if exist mirage-server.log del mirage-server.log >nul 2>&1
echo   Starting the local server...
start "Mirage server" /min cmd /c "%PYEXE% mirage_server.py > mirage-server.log 2>&1"

:: ------------------------------------------------------------------
:: 4. Wait for it to actually bind before opening the browser.
:: ------------------------------------------------------------------
call :waitForPort
if errorlevel 1 (
    echo.
    echo   [X] The server did not start. Its output was:
    echo   ------------------------------------------------------------
    if exist mirage-server.log type mirage-server.log
    echo   ------------------------------------------------------------
    echo.
    pause
    exit /b 1
)

echo   Ready - opening http://localhost:8080
start "" "http://localhost:8080"
exit /b 0


:: ==================================================================
:: Subroutines
:: ==================================================================

:: Probe one candidate interpreter. Keeps the first that is 3.8+.
:tryPy
if defined PYEXE exit /b 0
set "CAND=%~1"
%CAND% -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)" >nul 2>&1
if errorlevel 1 exit /b 0
set "PYEXE=%CAND%"
for /f "delims=" %%V in ('%CAND% -c "import sys; print(sys.version.split()[0])" 2^>nul') do set "PYVER=%%V"
exit /b 0

:: Reclaim port 8080 only from our own server; refuse to kill anything else.
:freePort
call :isMirage %1
if errorlevel 1 goto :freePortForeign
echo   Stopping the previous Mirage server ^(PID %1^)...
taskkill /PID %1 /F >nul 2>&1
timeout /t 1 /nobreak >nul
exit /b 0
:freePortForeign
echo.
echo   [X] Port 8080 is already in use by PID %1, which is not Mirage.
echo.
echo       Close that program first, or change PORT near the top of
echo       mirage_server.py to a free port.
echo.
pause
exit /b 1

:: Poll the port for up to ~10s so the browser never opens on a dead server.
:waitForPort
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8080); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 250 } }; exit 1" >nul 2>&1
exit /b %errorlevel%

:: Is this PID our own server? Checks the command line rather than assuming
:: whatever holds port 8080 belongs to Mirage.
:isMirage
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + %1) -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*mirage_server.py*') { exit 0 } else { exit 1 }" >nul 2>&1
exit /b %errorlevel%
