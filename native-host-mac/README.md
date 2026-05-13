# Bukeala Native Host — macOS Edition

Mantiene la sesión Bukeala viva 24/7 desde tu Mac. Usa **launchd** (servicio nativo de macOS) para arrancar al boot y reiniciarse solo si crashea.

## 📋 Requisitos

- **macOS** 11+ (Big Sur o más nuevo)
- **Node.js 18+** instalado (`node --version`)
- Una **2Captcha API key** con saldo ≥ $5 USD (para auto-login sin tu intervención). Si no tienes, igual funciona pero abre Chromium cada vez para login manual.
- El **Capture Token** del Cloudflare Worker (te lo da el doctor)

### Instalar Node.js si no lo tienes

Lo más fácil con Homebrew:

```bash
# Si no tienes Homebrew, primero:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Instalar Node:
brew install node
```

## 🚀 Instalación (5 minutos)

```bash
# 1. Descargar/clonar el repo en cualquier carpeta
cd ~/Documents
git clone https://github.com/Ddropero/bukeala-bot.git
cd bukeala-bot/native-host-mac

# 2. Dar permisos a los scripts
chmod +x install.sh uninstall.sh renovar.sh logs.sh

# 3. Correr el instalador
bash install.sh
```

El instalador te va a preguntar:

1. **Worker URL** (default OK: `https://bukeala-bot.ddropero.workers.dev/capture`)
2. **Capture token** (ej. `ff0a8423...`)
3. **2Captcha API key** (opcional)
4. **Usuario CAS** (ej. `80040718.prest`)
5. **Password CAS** (oculto)

Cuando termine: ✅ Servicio cargado en launchd y corriendo.

## 🗂️ Dónde se guarda qué

```
~/Documents/bukeala-bot/native-host-mac/    # Código + node_modules
~/Library/Application Support/BukealaBot/   # Config + logs + state
   ├── config.json         (worker URL + tokens, mode 0600)
   ├── creds.dat           (credenciales CAS cifradas AES-256-GCM, mode 0600)
   ├── state.json          (cookies de Playwright)
   ├── watcher.log         (logs del polling)
   ├── watcher.out.log     (stdout del launchd)
   ├── watcher.err.log     (stderr del launchd)
   └── last-run.log        (logs del último auto-login)

~/.bukeala-key             (master key AES-256, mode 0600 — NO BORRAR)
~/Library/LaunchAgents/com.bukeala.watcher.plist  (config del servicio)
```

## ⚙️ Comandos útiles

```bash
# Ver logs en vivo
bash logs.sh

# Forzar renovación de sesión manualmente
bash renovar.sh

# Estado del servicio launchd
launchctl list | grep bukeala

# Reiniciar el servicio
launchctl unload ~/Library/LaunchAgents/com.bukeala.watcher.plist
launchctl load   ~/Library/LaunchAgents/com.bukeala.watcher.plist

# Desinstalar
bash uninstall.sh
```

## 🔋 IMPORTANTE: que el Mac NO se duerma

Para que el watcher corra 24/7, el Mac no se debe poner a dormir. Configuración:

**Vía GUI:**

Sistema → Configuración → Energía →
- "Impedir que el equipo se duerma cuando la pantalla esté apagada" ✓
- "Iniciar automáticamente después de un fallo de energía" ✓
- "Reactivar al acceder a la red" ✓

**Vía Terminal:**

```bash
# Disable sleep + disksleep, enable wake-on-LAN
sudo pmset -a sleep 0 disksleep 0 womp 1

# Ver configuración actual
pmset -g
```

## 🔐 Seguridad

- Credenciales cifradas con **AES-256-GCM**
- Master key (32 bytes random) en `~/.bukeala-key` con permisos `0600` (solo tu user puede leerla)
- Si alguien copia `creds.dat` a otra Mac, **no podrá descifrarlo** sin tu master key
- `config.json` y `creds.dat` también con `0600`

## 🐛 Troubleshooting

### El servicio no arranca

```bash
# Ver log de errores
cat ~/Library/Application\ Support/BukealaBot/watcher.err.log

# Listar el servicio
launchctl list | grep bukeala
```

### "Permission denied" al cargar plist

```bash
chmod 644 ~/Library/LaunchAgents/com.bukeala.watcher.plist
launchctl load ~/Library/LaunchAgents/com.bukeala.watcher.plist
```

### El auto-login falla

```bash
# Ver el último error
cat ~/Library/Application\ Support/BukealaBot/last-run.log | tail -30

# Forzar setup manual
bash renovar.sh   # si no hay 2Captcha, abre Chromium
```

### Necesito cambiar el 2Captcha key

```bash
# Editar config.json directamente
nano ~/Library/Application\ Support/BukealaBot/config.json
# Cambiar "twoCaptchaApiKey": "NUEVO_KEY"
# Guardar (Ctrl+O, Ctrl+X)

# Reiniciar el servicio
launchctl unload ~/Library/LaunchAgents/com.bukeala.watcher.plist
launchctl load   ~/Library/LaunchAgents/com.bukeala.watcher.plist
```

## ❌ Migrar desde Windows

Si tenías el Native Host corriendo en Windows:

1. En el Mac: corre `bash install.sh` aquí (sigue los pasos de arriba)
2. En el Windows: para las Scheduled Tasks:
   ```powershell
   Get-ScheduledTask -TaskName "BukealaBot*" | Disable-ScheduledTask
   ```
3. Opcional: borrar `C:\BukealaBot\` en Windows

Las credenciales CAS son las mismas (mismo Bukeala). No hay que cambiar nada en el Worker de Cloudflare.

## 📞 Ayuda

Si algo no funciona, manda screenshot del log:

```bash
cat ~/Library/Application\ Support/BukealaBot/watcher.log | tail -50
```
