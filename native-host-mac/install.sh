#!/bin/bash
# ============================================================================
# Bukeala Native Host — Instalador macOS
# ============================================================================
# Instala el watcher + auto-login como servicio launchd que arranca al boot
# y se mantiene corriendo 24/7.
#
# Uso:
#   bash install.sh
#
# Lo que hace:
#   1. Verifica Node.js + npm + Playwright Chromium
#   2. Pide capture token + 2Captcha key + credenciales CAS
#   3. Cifra credenciales (AES-256-GCM con master key local)
#   4. Crea launchd plist en ~/Library/LaunchAgents/
#   5. Carga el servicio (arranca automáticamente)
# ============================================================================

set -e

# --- Colores para output ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() { echo -e "${BLUE}▸ $1${NC}"; }
print_ok()   { echo -e "${GREEN}✓ $1${NC}"; }
print_warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_err()  { echo -e "${RED}✗ $1${NC}"; }

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Library/Application Support/BukealaBot"
PLIST_PATH="$HOME/Library/LaunchAgents/com.bukeala.watcher.plist"
PLIST_LABEL="com.bukeala.watcher"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  BUKEALA NATIVE HOST — INSTALADOR macOS"
echo "═══════════════════════════════════════════════════════════"
echo ""

# --- 1. Verificar Node.js ---
print_step "Verificando Node.js..."
if ! command -v node &> /dev/null; then
  print_err "Node.js no encontrado."
  echo "Instala con: brew install node"
  echo "(si no tienes Homebrew: https://brew.sh)"
  exit 1
fi
NODE_VER=$(node --version)
print_ok "Node.js $NODE_VER"

# --- 2. Crear APP_DIR ---
print_step "Creando directorio de datos: $APP_DIR"
mkdir -p "$APP_DIR"
print_ok "APP_DIR listo"

# --- 3. npm install ---
print_step "Instalando dependencias (Playwright + stealth)..."
cd "$SCRIPT_DIR"
if [ ! -d "node_modules" ]; then
  npm install --no-audit --no-fund
fi
print_ok "node_modules instalados"

# --- 4. Playwright Chromium ---
print_step "Verificando Chromium (Playwright)..."
npx playwright install chromium
print_ok "Chromium listo"

# --- 5. Configuración (config.json) ---
echo ""
print_step "Configuración inicial — pide el capture token y la 2Captcha key"
echo ""

# Default worker URL
DEFAULT_WORKER="https://bukeala-bot.ddropero.workers.dev/capture"
read -p "Worker URL [$DEFAULT_WORKER]: " WORKER_URL
WORKER_URL="${WORKER_URL:-$DEFAULT_WORKER}"

read -p "Capture token (del Cloudflare worker, ej. ff0a...): " CAPTURE_TOKEN
if [ -z "$CAPTURE_TOKEN" ]; then
  print_err "Capture token vacío."
  exit 1
fi

read -p "2Captcha API key (opcional, dejar vacío para login manual): " TWOCAPTCHA_KEY

# Guardar config.json
cat > "$APP_DIR/config.json" <<EOF
{
  "workerUrl": "$WORKER_URL",
  "captureToken": "$CAPTURE_TOKEN"$([ -n "$TWOCAPTCHA_KEY" ] && echo ",")
$([ -n "$TWOCAPTCHA_KEY" ] && echo "  \"twoCaptchaApiKey\": \"$TWOCAPTCHA_KEY\"")
}
EOF
chmod 600 "$APP_DIR/config.json"
print_ok "config.json guardado (mode 0600)"

# --- 6. Credenciales CAS ---
echo ""
print_step "Credenciales CAS Colsanitas"
echo "Se cifran con AES-256-GCM (master key local en ~/.bukeala-key)"
echo ""

# Llamamos al modo --save-credentials del index.js (interactivo)
node "$SCRIPT_DIR/index.js" --save-credentials
if [ $? -ne 0 ]; then
  print_err "Credenciales no guardadas."
  exit 1
fi

# Copiar creds.dat al APP_DIR si no está ya ahí
if [ -f "$APP_DIR/creds.dat" ]; then
  print_ok "creds.dat cifrado en $APP_DIR/creds.dat"
else
  print_err "creds.dat no se generó. Algo falló."
  exit 1
fi

# --- 7. Configurar launchd plist ---
echo ""
print_step "Configurando launchd para arranque automático..."

NODE_PATH=$(which node)
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SCRIPT_DIR/watcher.js</string>
        <string>--worker</string>
        <string>$WORKER_URL</string>
        <string>--token</string>
        <string>$CAPTURE_TOKEN</string>
$([ -n "$TWOCAPTCHA_KEY" ] && cat <<INNER
        <string>--2captcha-key</string>
        <string>$TWOCAPTCHA_KEY</string>
        <string>--auto-login-mode</string>
INNER
)
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$APP_DIR/watcher.out.log</string>
    <key>StandardErrorPath</key>
    <string>$APP_DIR/watcher.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"
print_ok "plist creado en $PLIST_PATH"

# --- 8. Cargar launchd service ---
print_step "Cargando servicio launchd..."

# Si ya está cargado de instalación previa, descargarlo primero
if launchctl list | grep -q "$PLIST_LABEL"; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

launchctl load "$PLIST_PATH"
sleep 2

# Verificar
if launchctl list | grep -q "$PLIST_LABEL"; then
  print_ok "Servicio cargado y corriendo"
else
  print_warn "El servicio puede no estar corriendo. Revisa: launchctl list | grep bukeala"
fi

# --- 9. Si no hay 2Captcha, hacer setup manual ---
if [ -z "$TWOCAPTCHA_KEY" ]; then
  echo ""
  print_warn "Sin 2Captcha key — necesitas hacer setup manual una vez."
  echo "Corre AHORA: node $SCRIPT_DIR/index.js --setup"
  echo "Y completa el login en la ventana Chromium que se abra."
  echo ""
  read -p "¿Hacer setup ahora? [Y/n]: " DO_SETUP
  DO_SETUP="${DO_SETUP:-Y}"
  if [[ "$DO_SETUP" =~ ^[Yy] ]]; then
    node "$SCRIPT_DIR/index.js" --setup
  fi
fi

# --- 10. Final ---
echo ""
echo "═══════════════════════════════════════════════════════════"
print_ok "INSTALACIÓN COMPLETA"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📂 APP_DIR:       $APP_DIR"
echo "🔐 Master key:    ~/.bukeala-key"
echo "📋 Plist:         $PLIST_PATH"
echo "📝 Logs:          $APP_DIR/watcher.log"
echo ""
echo "Comandos útiles:"
echo "  ./logs.sh                    Ver logs en vivo"
echo "  ./renovar.sh                 Forzar renovación de sesión"
echo "  launchctl list | grep bukeala     Ver estado del servicio"
echo "  launchctl unload $PLIST_PATH      Parar servicio"
echo "  launchctl load   $PLIST_PATH      Arrancar servicio"
echo "  bash uninstall.sh            Desinstalar todo"
echo ""
echo "Para que el Mac no se duerma:"
echo "  Sistema → Configuración → Energía → 'Impedir que el equipo se duerma'"
echo "  o desde Terminal: sudo pmset -a sleep 0 disksleep 0 womp 1"
echo ""
