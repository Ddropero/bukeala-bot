#!/bin/bash
# Renovar sesión Bukeala manualmente (fuerza un --auto-login o --setup)
#
# Útil si la sesión se cayó y quieres forzar el ciclo sin esperar al cron
# del Worker. NO necesario en uso normal — el watcher la mantiene viva sola.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Library/Application Support/BukealaBot"
CONFIG="$APP_DIR/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "❌ config.json no existe. Corre install.sh primero."
  exit 1
fi

# Decidir si auto-login (con 2Captcha) o setup manual
if grep -q "twoCaptchaApiKey" "$CONFIG"; then
  echo "🤖 Renovando vía auto-login (2Captcha)..."
  cd "$SCRIPT_DIR" && node index.js --auto-login
else
  echo "🖱️  Renovando vía setup manual (se abre Chromium)..."
  cd "$SCRIPT_DIR" && node index.js --setup
fi
