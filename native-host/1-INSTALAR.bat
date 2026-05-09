@echo off
REM Doble click → corre el instalador en PowerShell
title Bukeala Bot — Instalacion
echo.
echo ================================================
echo    BUKEALA BOT - INSTALACION
echo ================================================
echo.
echo Este script va a:
echo   1. Verificar Node.js
echo   2. Instalar dependencias (Playwright + Chromium)
echo   3. Crear configuracion
echo   4. Hacer login inicial (se abrira ventana)
echo   5. Programar tareas automaticas
echo.
pause

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0install.ps1"

echo.
echo ================================================
pause
