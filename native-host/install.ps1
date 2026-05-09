# Bukeala Native Host — Instalador completo
#
# Hace todo en un solo paso:
#   1. Verifica Node.js
#   2. Instala dependencias (Playwright + Chromium)
#   3. Crea carpeta de datos en %APPDATA%\BukealaBot
#   4. Pide capture token (worker URL tiene default)
#   5. Hace setup inicial (login visible) — se abre ventana, logueas, cierra sola
#   6. Crea las 2 Scheduled Tasks (refresh cada 4h + watcher continuo)
#   7. Verifica que todo está corriendo
#
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1

[CmdletBinding()]
param(
    [string]$WorkerUrl = "https://bukeala-bot.ddropero.workers.dev/capture",
    [string]$CaptureToken = "",
    [string]$RefreshTaskName = "BukealaBotSessionRefresh",
    [string]$WatcherTaskName = "BukealaBotRefreshWatcher"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Section([string]$text) {
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Test-Cmd($cmd) {
    $null = Get-Command $cmd -ErrorAction SilentlyContinue
    return $?
}

# -------------------------------------------------------------------
# 0. Sanity: warn if installed inside OneDrive (file sync issues)
# -------------------------------------------------------------------
if ($scriptDir -match "OneDrive") {
    Write-Host ""
    Write-Host "[!] ADVERTENCIA: estos archivos están en OneDrive ($scriptDir)" -ForegroundColor Yellow
    Write-Host "    OneDrive puede causar problemas con el Native Host." -ForegroundColor Yellow
    Write-Host "    RECOMENDADO: mover esta carpeta a C:\BukealaBot\ y volver a correr install.ps1" -ForegroundColor Yellow
    Write-Host ""
    $cont = Read-Host "¿Continuar de todos modos? (s/n)"
    if ($cont -ne "s") {
        Write-Host "Abortado. Mueve la carpeta y vuelve a correr." -ForegroundColor Red
        exit 1
    }
}

# -------------------------------------------------------------------
# 1. Node.js LTS check
# -------------------------------------------------------------------
Write-Section "Verificando Node.js"
if (-not (Test-Cmd "node")) {
    Write-Host "[X] Node.js no instalado." -ForegroundColor Red
    Write-Host "    Descárgalo de https://nodejs.org/ (LTS, Windows Installer)" -ForegroundColor Yellow
    Write-Host "    Después vuelve a correr este script." -ForegroundColor Yellow
    exit 1
}
$nodeVer = (node -v).TrimStart("v")
$major = [int]($nodeVer.Split(".")[0])
if ($major -lt 18) {
    Write-Host "[X] Node v$nodeVer es muy viejo. Necesito >= 18." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Node v$nodeVer" -ForegroundColor Green

# -------------------------------------------------------------------
# 2. npm install (Playwright + plugins + Chromium ~120 MB)
# -------------------------------------------------------------------
Write-Section "Instalando dependencias (~1-2 min, descarga Chromium ~120 MB)"
Push-Location $scriptDir
try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install failed" }
} finally {
    Pop-Location
}
Write-Host "[OK] Dependencias listas" -ForegroundColor Green

# -------------------------------------------------------------------
# 3. AppData directory
# -------------------------------------------------------------------
Write-Section "Creando carpeta de datos"
$appDir = Join-Path $env:APPDATA "BukealaBot"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Write-Host "[OK] $appDir" -ForegroundColor Green

# -------------------------------------------------------------------
# 4. Capture token (worker URL has default)
# -------------------------------------------------------------------
Write-Section "Configuración del Worker"
Write-Host "Worker URL: $WorkerUrl" -ForegroundColor Gray
$inputUrl = Read-Host "Worker URL (Enter para usar el default)"
if ($inputUrl -and $inputUrl.Trim()) { $WorkerUrl = $inputUrl.Trim() }

if (-not $CaptureToken) {
    $CaptureToken = Read-Host "Capture token (te lo dio el doctor)"
}
if (-not $CaptureToken -or $CaptureToken.Trim() -eq "") {
    Write-Host "[X] Capture token vacío, abortando." -ForegroundColor Red
    exit 1
}

# Save config.json (used by index.js for cookie push)
$config = [PSCustomObject]@{
    workerUrl    = $WorkerUrl
    captureToken = $CaptureToken
}
$configFile = Join-Path $appDir "config.json"
$config | ConvertTo-Json | Set-Content -Path $configFile -Encoding UTF8 -NoNewline
Write-Host "[OK] Config guardado en $configFile" -ForegroundColor Green

# -------------------------------------------------------------------
# 5. Setup inicial — se abre ventana visible, usuario loguea
# -------------------------------------------------------------------
Write-Section "Login inicial (se abre Chromium en tu pantalla)"
Write-Host ""
Write-Host "Se va a abrir una ventana de Chromium con el login de Bukeala." -ForegroundColor Yellow
Write-Host "1. Loguea con tu usuario CAS Colsanitas" -ForegroundColor Yellow
Write-Host "2. Resuelve el reCAPTCHA" -ForegroundColor Yellow
Write-Host "3. Espera a ver la pagina principal de Bukeala" -ForegroundColor Yellow
Write-Host "4. La ventana se cierra sola en ~3 seg" -ForegroundColor Yellow
Write-Host ""
Read-Host "Presiona Enter cuando estes listo"

Push-Location $scriptDir
try {
    & node index.js --setup
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] Setup fallo. Revisa $appDir\last-run.log" -ForegroundColor Red
        Write-Host "    Puedes re-correr el setup con: node index.js --setup" -ForegroundColor Yellow
        exit 1
    }
} finally {
    Pop-Location
}
Write-Host "[OK] Login OK" -ForegroundColor Green

# -------------------------------------------------------------------
# 6a. Test push de cookies al worker
# -------------------------------------------------------------------
Write-Section "Push de cookies al worker (test)"
Push-Location $scriptDir
try {
    & node index.js
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Push fallo — verifica que el worker URL y token sean correctos." -ForegroundColor Yellow
    } else {
        Write-Host "[OK] Cookies pushed al worker" -ForegroundColor Green
    }
} finally {
    Pop-Location
}

# -------------------------------------------------------------------
# 7. Scheduled Tasks
# -------------------------------------------------------------------
Write-Section "Programando Scheduled Tasks"
$nodePath = (Get-Command node).Source
$indexPath = Join-Path $scriptDir "index.js"
$watcherPath = Join-Path $scriptDir "watcher.js"

# --- 7a. Refresh task: every 4h, runs index.js (no args needed, reads config.json)
if (Get-ScheduledTask -TaskName $RefreshTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $RefreshTaskName -Confirm:$false
}
$refreshAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$indexPath`"" -WorkingDirectory $scriptDir
$refreshTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 4)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$refreshSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $RefreshTaskName -Action $refreshAction -Trigger $refreshTrigger -Principal $principal -Settings $refreshSettings -Description "Refresca cookies Bukeala cada 4 horas" | Out-Null
Write-Host "[OK] Tarea: $RefreshTaskName (cada 4 horas)" -ForegroundColor Green

# --- 7b. Watcher task: at logon, runs watcher.js with args (so config doesn't need to be readable)
if (Get-ScheduledTask -TaskName $WatcherTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $WatcherTaskName -Confirm:$false
}
$watcherArgs = "`"$watcherPath`" --worker $WorkerUrl --token $CaptureToken"
$watcherAction = New-ScheduledTaskAction -Execute $nodePath -Argument $watcherArgs -WorkingDirectory $scriptDir
$watcherTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watcherSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $WatcherTaskName -Action $watcherAction -Trigger $watcherTrigger -Principal $principal -Settings $watcherSettings -Description "Polls worker every 30s for /sesion_renew Telegram requests" | Out-Null

Start-ScheduledTask -TaskName $WatcherTaskName
Write-Host "[OK] Tarea: $WatcherTaskName (continuo, ya corriendo)" -ForegroundColor Green

# -------------------------------------------------------------------
# 8. Resumen final
# -------------------------------------------------------------------
Write-Section "INSTALACION COMPLETA"
Write-Host ""
Write-Host "El bot quedo configurado. Que sigue:" -ForegroundColor Green
Write-Host ""
Write-Host "  - El bot Telegram puede usar Bukeala normalmente"
Write-Host "  - Cada 4 horas se refrescan cookies automaticamente"
Write-Host "  - Si el TGC expira, te llega aviso por Telegram"
Write-Host "  - En Telegram puedes mandar /sesion_renew → se abre login en este PC"
Write-Host ""
Write-Host "Comandos utiles:" -ForegroundColor Cyan
Write-Host "  - Ver tareas:        Get-ScheduledTask -TaskName Bukeala*"
Write-Host "  - Forzar refresh:    Start-ScheduledTask -TaskName $RefreshTaskName"
Write-Host "  - Re-login manual:   node index.js --setup"
Write-Host "  - Ver logs:          Get-Content `$env:APPDATA\BukealaBot\*.log -Tail 20"
Write-Host "  - Desinstalar:       powershell -ExecutionPolicy Bypass -File uninstall.ps1"
Write-Host ""
