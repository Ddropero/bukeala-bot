@echo off
REM Agregar 2Captcha a una instalacion existente
title Bukeala Bot — Agregar 2Captcha (auto-login)
echo.
echo ================================================
echo    AGREGAR 2CAPTCHA (auto-login sin manos)
echo ================================================
echo.
echo Necesitas:
echo  1. Cuenta 2Captcha con saldo (~`$5 USD)
echo  2. Tu API key de 2Captcha
echo  3. Tu usuario+password CAS Colsanitas
echo.
pause

powershell -ExecutionPolicy Bypass -NoProfile -Command "& {
  $cfgPath = Join-Path $env:APPDATA 'BukealaBot\config.json'
  if (-not (Test-Path $cfgPath)) {
    Write-Host '[X] Bot no instalado. Corre 1-INSTALAR.bat primero.' -ForegroundColor Red
    exit 1
  }
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $key = Read-Host '2Captcha API key'
  if (-not $key -or $key.Trim() -eq '') { Write-Host 'Cancelado.'; exit 1 }
  if ($cfg.PSObject.Properties.Name -contains 'twoCaptchaApiKey') {
    $cfg.twoCaptchaApiKey = $key.Trim()
  } else {
    $cfg | Add-Member -NotePropertyName twoCaptchaApiKey -NotePropertyValue $key.Trim()
  }
  $cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8 -NoNewline
  Write-Host '[OK] API key guardada en config.json' -ForegroundColor Green
}"

echo.
echo ================================================
echo Ahora guardo tus credenciales CAS (DPAPI encrypted)...
echo ================================================
echo.
cd /d "%~dp0"
node index.js --save-credentials

echo.
echo ================================================
echo Listo! El proximo /sesion_renew sera AUTOMATICO.
echo No necesitas estar cerca del PC para resolver reCAPTCHA.
echo ================================================
pause
