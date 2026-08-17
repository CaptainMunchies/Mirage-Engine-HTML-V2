@echo off
title Mirage Engine — Stop
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo Mirage server stopped (if it was running).
timeout /t 2 /nobreak >nul
