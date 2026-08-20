@echo off
setlocal
title Mirage Engine - Update

REM Pull the latest claude/mirage-v3 into this folder.
REM
REM Safe by design: it refuses to run if you have uncommitted changes, so it can
REM never silently throw away something you edited by hand. Your characters,
REM chats and photos are in the browser, not in this folder, so updating the code
REM never touches them.

REM ---------------------------------------------------------------------------
REM Run from a copy in TEMP, not from the repo.
REM
REM cmd.exe does not load a .bat into memory. It reads one line, runs it, then
REM seeks back to a byte offset for the next one. This script's whole job is to
REM pull changes - which can include changes to this script. Replacing the file
REM underneath a running cmd.exe leaves that offset pointing into different text,
REM and it will happily execute whatever now sits there.
REM
REM So: stage a copy in TEMP, hand it the repo path, and let it do the work. Git
REM is then free to rewrite the repo copy, and the next run picks up the new
REM version because it re-stages from the repo each time.
REM ---------------------------------------------------------------------------
if "%~1"=="" (
    copy /y "%~f0" "%TEMP%\mirage-update-runner.bat" >nul 2>nul
    if not errorlevel 1 (
        call "%TEMP%\mirage-update-runner.bat" "%~dp0"
        exit /b
    )
    echo Note: could not stage the updater in %TEMP%, so it is running in place.
    echo If this update changes the updater itself, run it once more afterwards.
    echo.
)

if "%~1"=="" (set "REPO=%~dp0") else (set "REPO=%~1")
cd /d "%REPO%"

where git >nul 2>nul
if errorlevel 1 (
    echo Git is not installed, or not on PATH.
    echo Install it from https://git-scm.com/download/win and run this again.
    goto :done
)

if not exist ".git" (
    echo This folder is not a git clone, so there is nothing to pull into.
    echo.
    echo Clone it once instead, into a folder of your choice:
    echo     git clone -b claude/mirage-v3 https://github.com/CaptainMunchies/Mirage-Engine-HTML-V2.git
    goto :done
)

echo Checking for local changes...
git diff --quiet && git diff --cached --quiet
if errorlevel 1 (
    echo.
    echo You have uncommitted changes in this folder. Stopping rather than
    echo overwriting them. Review them with:
    echo     git status
    echo.
    echo Then either keep them:      git stash
    echo or throw them away:         git checkout -- .
    echo and run this again.
    goto :done
)

echo Fetching...
git fetch origin claude/mirage-v3
if errorlevel 1 (
    echo.
    echo Could not reach GitHub. Check your connection and try again.
    goto :done
)

REM Record where we were, so the summary below can show what actually changed.
for /f "delims=" %%i in ('git rev-parse HEAD') do set BEFORE=%%i

git checkout claude/mirage-v3 >nul 2>nul
git merge --ff-only origin/claude/mirage-v3
if errorlevel 1 (
    echo.
    echo Could not fast-forward. Your branch has commits that are not on GitHub.
    echo Nothing was changed. Inspect with:  git log --oneline -10
    goto :done
)

for /f "delims=" %%i in ('git rev-parse HEAD') do set AFTER=%%i

echo.
if "%BEFORE%"=="%AFTER%" (
    echo Already up to date - nothing new to pull.
    goto :done
)

echo Updated. What changed:
echo.
git log --oneline %BEFORE%..%AFTER%
echo.

REM Python reads mirage_server.py once, at startup. If this update touched it, a
REM server that is already running is still executing the old code and will keep
REM doing so until it is restarted - which is exactly the kind of silent staleness
REM this project has been bitten by before.
git diff --name-only %BEFORE% %AFTER% > "%TEMP%\mirage_changed.txt"
findstr /C:"mirage_server.py" "%TEMP%\mirage_changed.txt" >nul
if not errorlevel 1 (
    echo ============================================================
    echo   THE SERVER CHANGED IN THIS UPDATE - RESTART IT.
    echo.
    echo   Close the black Mirage server window ^(or run STOP MIRAGE.bat^),
    echo   then run START MIRAGE.bat again. Until you do, the running
    echo   server is still the old one.
    echo ============================================================
    echo.
)
del "%TEMP%\mirage_changed.txt" >nul 2>nul

echo In your browser, press Ctrl+Shift+R on the Mirage tab so it loads the new
echo code instead of the copy it has cached.

:done
echo.
pause
endlocal
