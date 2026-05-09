@echo off
REM Doble click → muestra los últimos logs para diagnóstico
title Bukeala Bot — Logs
echo.
echo ================================================
echo    LOGS DEL BUKEALA BOT
echo ================================================
echo.

echo === Ultimas 10 corridas (refresh) ===
powershell -NoProfile -Command "Get-Content $env:APPDATA\BukealaBot\last-run.log -Tail 10"
echo.

echo === Watcher (poll de Telegram /sesion_renew) ===
powershell -NoProfile -Command "Get-Content $env:APPDATA\BukealaBot\watcher.log -Tail 10"
echo.

echo === Tareas programadas ===
powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'Bukeala*' | Format-Table TaskName, State -AutoSize"
powershell -NoProfile -Command "Get-ScheduledTaskInfo -TaskName 'BukealaBotSessionRefresh' | Format-List LastRunTime, LastTaskResult, NextRunTime"
echo.

pause
