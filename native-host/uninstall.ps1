# Bukeala Native Host — Desinstalador
# Borra Scheduled Tasks + carpeta de datos.

[CmdletBinding()]
param(
    [string]$RefreshTaskName = "BukealaBotSessionRefresh",
    [string]$WatcherTaskName = "BukealaBotRefreshWatcher"
)

$ErrorActionPreference = "Stop"

foreach ($t in @($RefreshTaskName, $WatcherTaskName)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "[OK] Tarea $t eliminada" -ForegroundColor Green
    } else {
        Write-Host "[i] Tarea $t no existia"
    }
}

$appDir = Join-Path $env:APPDATA "BukealaBot"
if (Test-Path $appDir) {
    Write-Host ""
    $del = Read-Host "¿Borrar tambien $appDir (config, cookies, logs)? (s/n)"
    if ($del -eq "s") {
        Remove-Item -Path $appDir -Recurse -Force
        Write-Host "[OK] Carpeta eliminada" -ForegroundColor Green
    } else {
        Write-Host "[i] Carpeta conservada"
    }
} else {
    Write-Host "[i] Carpeta $appDir no existia"
}

Write-Host ""
Write-Host "Desinstalado. Para reinstalar, corre install.ps1 de nuevo."
