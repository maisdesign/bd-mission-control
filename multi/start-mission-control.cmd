@echo off
rem Avvia Mission Control (server nascosto, se non gia' attivo) e apre il browser.
setlocal
set "MC_DIR=%~dp0"
powershell -NoProfile -WindowStyle Hidden -Command ^
  "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8766/api/state | Out-Null } catch { Start-Process -WindowStyle Hidden -FilePath node -ArgumentList ('\"' + $env:MC_DIR + 'server.mjs\"') -WorkingDirectory $env:MC_DIR; for ($i=0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 300; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8766/api/state | Out-Null; break } catch {} } }"
start "" http://127.0.0.1:8766/
