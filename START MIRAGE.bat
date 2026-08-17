@echo off
title Mirage Engine
cd /d "%~dp0"

:: Kill any previous Mirage server on port 8080
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1

:: Let the old socket release before rebinding
timeout /t 1 /nobreak >nul

:: Start Mirage server (static files + API proxy for Nano Banana)
start /min "" cmd /c "py -3.11 mirage_server.py"

:: Wait for server to bind
timeout /t 3 /nobreak >nul

:: Open Mirage in default browser
start "" "http://localhost:8080"

exit
