#!/bin/bash
# Tail de los logs del watcher y last-run en vivo

APP_DIR="$HOME/Library/Application Support/BukealaBot"

echo "═══════════════════════════════════════════════════════════"
echo "  Logs BukealaBot — Ctrl+C para salir"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Watcher log: $APP_DIR/watcher.log"
echo "Last-run:    $APP_DIR/last-run.log"
echo ""

# Tail ambos archivos en paralelo
tail -F "$APP_DIR/watcher.log" "$APP_DIR/last-run.log" 2>/dev/null
