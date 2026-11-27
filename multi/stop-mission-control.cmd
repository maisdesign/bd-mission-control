@echo off
rem Ferma il server di Mission Control e l'icona nell'area di notifica (tray.ps1 di questa cartella).
set "MC_DIR=%~dp0"
powershell -NoProfile -Command "$t = Join-Path $env:MC_DIR 'tray.ps1'; Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($t) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"127.0.0.1:8766 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo Mission Control fermato.
