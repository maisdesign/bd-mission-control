@echo off
rem Avvia Mission Control (server nascosto, se non gia' attivo) e apre il browser.
rem Argomento facoltativo: lo slug di un progetto, per aprire direttamente la sua scheda
rem   start-mission-control.cmd mio-progetto   ->  http://127.0.0.1:8766/#mio-progetto
setlocal
set "MC_DIR=%~dp0"
set "MC_TAB=%~1"
powershell -NoProfile -WindowStyle Hidden -Command ^
  "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8766/ | Out-Null } catch { Start-Process -WindowStyle Hidden -FilePath node -ArgumentList ('\"' + $env:MC_DIR + 'server.mjs\"') -WorkingDirectory $env:MC_DIR; for ($i=0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 300; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8766/ | Out-Null; break } catch {} } }"
rem Icona nell'area di notifica (istanza unica: se c'e' gia' non ne parte un'altra).
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%MC_DIR%tray.ps1" -Port 8766
if defined MC_TAB (start "" "http://127.0.0.1:8766/#%MC_TAB%") else (start "" http://127.0.0.1:8766/)
