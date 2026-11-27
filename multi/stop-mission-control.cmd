@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"127.0.0.1:8766 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo Mission Control fermato.
