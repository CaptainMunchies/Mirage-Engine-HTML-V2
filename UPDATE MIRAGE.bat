@echo off
setlocal
title Mirage Engine - Update

REM Pull the latest claude/mirage-v3 into this folder.
REM
REM Safe by design: it refuses to run if you have uncommitted changes, so it can
REM never silently throw away something you edited by hand. Your characters,
REM chats and photos are in the browser, not in this folder, so updating the code
REM never touches them.

cd /d "%~dp0"

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
) else (
    echo Updated. What changed:
    echo.
    git log --oneline %BEFORE%..%AFTER%
    echo.
    echo IMPORTANT: in your browser, press Ctrl+Shift+R on the Mirage tab so it
    echo loads the new code instead of the copy it has cached.
)

:done
echo.
pause
endlocal
