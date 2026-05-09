@echo off
title Bukeala Bot — Desinstalacion
echo.
echo ================================================
echo    DESINSTALAR BUKEALA BOT
echo ================================================
echo.
echo Esto va a eliminar las tareas programadas
echo y opcionalmente la configuracion + cookies.
echo.
pause

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0uninstall.ps1"

echo.
pause
