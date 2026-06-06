#!/usr/bin/env bash
# Genera startup-script.sh autocontenido: instala node+chromium, embebe
# watcher.js + autoLogin.js + package.json, crea systemd service.
# Las credenciales NO van aquí — se inyectan como metadata aparte (más seguro).
set -e
OUT="startup-script.sh"

cat > "$OUT" <<'HEADER'
#!/usr/bin/env bash
# ====================================================================
# Bukeala session keeper — GCE startup script (Debian 12)
# Idempotente: se puede re-correr. Instala todo y arranca el systemd.
# ====================================================================
set -e
exec > /var/log/bukeala-setup.log 2>&1
echo "=== Bukeala setup START $(date) ==="

APP=/opt/bukeala
mkdir -p "$APP"

# --- Node 20 (si no está) ---
if ! command -v node >/dev/null 2>&1; then
  echo "Instalando Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node --version)"

# --- Credenciales desde metadata (no quedan en el script) ---
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
CAS_USERNAME=$(curl -s -H "$HDR" "$META/cas-username")
CAS_PASSWORD=$(curl -s -H "$HDR" "$META/cas-password")
TWO_CAPTCHA_API_KEY=$(curl -s -H "$HDR" "$META/twocaptcha-key")
CAPTURE_TOKEN=$(curl -s -H "$HDR" "$META/capture-token")
WORKER_URL=$(curl -s -H "$HDR" "$META/worker-url")
HEADER

# Embeber package.json
echo "" >> "$OUT"
echo "cat > \$APP/package.json <<'PKGEOF'" >> "$OUT"
cat package.json >> "$OUT"
echo "" >> "$OUT"
echo "PKGEOF" >> "$OUT"

# Embeber autoLogin.js
echo "" >> "$OUT"
echo "cat > \$APP/autoLogin.js <<'ALEOF'" >> "$OUT"
cat autoLogin.js >> "$OUT"
echo "" >> "$OUT"
echo "ALEOF" >> "$OUT"

# Embeber watcher.js
echo "" >> "$OUT"
echo "cat > \$APP/watcher.js <<'WEOF'" >> "$OUT"
cat watcher.js >> "$OUT"
echo "" >> "$OUT"
echo "WEOF" >> "$OUT"

# Resto: npm install + playwright deps + systemd
cat >> "$OUT" <<'FOOTER'

cd "$APP"
echo "npm install..."
npm install --omit=dev --no-audit --no-fund

# Chromium + dependencias del SO via playwright.
# CRÍTICO: PLAYWRIGHT_BROWSERS_PATH debe coincidir con el del systemd unit
# (/root/.cache/ms-playwright) y correr DESPUÉS de npm install para que use
# la versión de playwright fijada en package.json (no una efímera de npx).
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
echo "Instalando Chromium + deps del SO..."
npx playwright install --with-deps chromium

# systemd service
cat > /etc/systemd/system/bukeala.service <<UNIT
[Unit]
Description=Bukeala session keeper (cloud watcher)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
Environment=CAS_USERNAME=$CAS_USERNAME
Environment=CAS_PASSWORD=$CAS_PASSWORD
Environment=TWO_CAPTCHA_API_KEY=$TWO_CAPTCHA_API_KEY
Environment=CAPTURE_TOKEN=$CAPTURE_TOKEN
Environment=WORKER_URL=$WORKER_URL
Environment=POLL_INTERVAL_MS=30000
Environment=PROACTIVE_INTERVAL_MS=900000
Environment=PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ExecStart=/usr/bin/node $APP/watcher.js
Restart=always
RestartSec=15
StandardOutput=append:/var/log/bukeala.log
StandardError=append:/var/log/bukeala.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable bukeala.service
systemctl restart bukeala.service
echo "=== Bukeala setup DONE $(date) ==="
systemctl status bukeala.service --no-pager || true
FOOTER

echo "Generado $OUT ($(wc -c < "$OUT") bytes)"
