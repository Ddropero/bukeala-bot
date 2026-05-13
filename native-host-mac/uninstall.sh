#!/bin/bash
# Desinstalador del Native Host de Bukeala para macOS

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PLIST_PATH="$HOME/Library/LaunchAgents/com.bukeala.watcher.plist"
APP_DIR="$HOME/Library/Application Support/BukealaBot"

echo ""
echo "═══════════════════════════════════════════"
echo "  Desinstalador BukealaBot (macOS)"
echo "═══════════════════════════════════════════"
echo ""

# Parar y descargar launchd
if [ -f "$PLIST_PATH" ]; then
  echo -e "${YELLOW}▸ Parando servicio launchd...${NC}"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo -e "${GREEN}✓ launchd plist eliminado${NC}"
else
  echo -e "${YELLOW}⚠ plist no encontrado (ya estaba desinstalado?)${NC}"
fi

echo ""
echo "Archivos que NO se eliminan automáticamente (por seguridad):"
echo "  • $APP_DIR (config, creds, logs, state.json)"
echo "  • ~/.bukeala-key (master key)"
echo ""
read -p "¿Borrar también esos archivos? [y/N]: " WIPE
WIPE="${WIPE:-N}"
if [[ "$WIPE" =~ ^[Yy] ]]; then
  rm -rf "$APP_DIR"
  rm -f "$HOME/.bukeala-key"
  echo -e "${GREEN}✓ Archivos borrados${NC}"
else
  echo -e "${YELLOW}⚠ Conservados (puedes borrarlos manualmente cuando quieras)${NC}"
fi

echo ""
echo -e "${GREEN}✓ Desinstalación completa${NC}"
echo ""
