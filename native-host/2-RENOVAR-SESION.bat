@echo off
REM Doble click → corre setup manual (abre ventana, loguea, cierra)
title Bukeala Bot — Renovar sesion
echo.
echo ================================================
echo    RENOVAR SESION BUKEALA
echo ================================================
echo.
echo Se va a abrir una ventana de Chromium.
echo Loguea con tu usuario CAS Colsanitas + reCAPTCHA.
echo Cuando veas "Buscar disponibilidad" la ventana
echo se cerrara sola en 3 segundos.
echo.
pause

cd /d "%~dp0"
node index.js --setup

echo.
echo ================================================
echo    Si todo OK, las cookies estan refrescadas.
echo    Ya puedes usar el bot Telegram normalmente.
echo ================================================
pause
