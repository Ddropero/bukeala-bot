#!/usr/bin/env bash
# Genera startup-script.sh autocontenido: instala node+chromium, embebe
# módulos de sesión + package.json, crea systemd service.
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
mkdir -p "$APP" /var/lib/bukeala/browser-profile
chmod 700 /var/lib/bukeala /var/lib/bukeala/browser-profile

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
BROWSER_SESSION_MODE=$(curl -fsS -H "$HDR" "$META/browser-session-mode" 2>/dev/null || true)
ENABLE_FULL_LOGIN=$(curl -fsS -H "$HDR" "$META/enable-full-login" 2>/dev/null || true)
BROWSER_SESSION_MODE=${BROWSER_SESSION_MODE:-persistent}
ENABLE_FULL_LOGIN=${ENABLE_FULL_LOGIN:-0}
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

for module in persistentSession.js persistentWatcher.js persistentProbe.js; do
  printf '\ncat > "$APP/%s" <<\x27MODULEEOF\x27\n' "$module" >> "$OUT"
  cat "$module" >> "$OUT"
  printf '\nMODULEEOF\n' >> "$OUT"
done

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

# Chromium headed on a private virtual display. The site rejected the
# headless shell from this VM before showing its login form.
apt-get install -y xvfb xauth
touch /var/lib/bukeala/Xauthority
chmod 600 /var/lib/bukeala/Xauthority
if [ ! -s /var/lib/bukeala/Xauthority ]; then
  xauth -f /var/lib/bukeala/Xauthority add :99 . "$(openssl rand -hex 16)"
fi
cat > /etc/systemd/system/bukeala-display.service <<'DISPLAYUNIT'
[Unit]
Description=Private virtual display for Bukeala Chromium

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x800x24 -nolisten tcp -auth /var/lib/bukeala/Xauthority
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
DISPLAYUNIT

# --- Swap 1GB (la e2-micro tiene 1GB de RAM y Chromium vive 24/7) ---
# Sin swap, un pico de memoria mata Chromium: el ciclo siguiente hace login
# completo (gasta captcha) y deja un hueco de agenda. Idempotente.
if [ ! -f /swapfile ]; then
  echo "Creando swap de 1GB..."
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show || true

# --- Logrotate del log del watcher ---
# El watcher escribe JSON en cada tick a /var/log/bukeala.log (append, sin
# rotación): a la larga llena el disco y Chromium entra en crash loop.
cat > /etc/logrotate.d/bukeala <<'LOGROT'
/var/log/bukeala.log /var/log/bukeala-setup.log {
  daily
  rotate 7
  maxsize 50M
  compress
  missingok
  notifempty
  copytruncate
}
LOGROT

# systemd service
cat > /etc/systemd/system/bukeala.service <<UNIT
[Unit]
Description=Bukeala session keeper (cloud watcher)
After=network-online.target
Wants=network-online.target
After=bukeala-display.service
Requires=bukeala-display.service

[Service]
Type=simple
WorkingDirectory=$APP
Environment=CAS_USERNAME=$CAS_USERNAME
Environment=CAS_PASSWORD=$CAS_PASSWORD
Environment=TWO_CAPTCHA_API_KEY=$TWO_CAPTCHA_API_KEY
Environment=CAPTURE_TOKEN=$CAPTURE_TOKEN
Environment=WORKER_URL=$WORKER_URL
Environment=POLL_INTERVAL_MS=30000
# 10 min: la sesión de Bukeala vive ~10-15 min, con 15 min quedaban ventanas
# muertas entre renovaciones. Renovar es gratis (navegador vivo).
Environment=PROACTIVE_INTERVAL_MS=600000
Environment=PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
Environment=BROWSER_SESSION_MODE=$BROWSER_SESSION_MODE
Environment=BROWSER_PROFILE_DIR=/var/lib/bukeala/browser-profile
Environment=BROWSER_HEADLESS=0
Environment=DISPLAY=:99
Environment=XAUTHORITY=/var/lib/bukeala/Xauthority
Environment=ENABLE_FULL_LOGIN=$ENABLE_FULL_LOGIN
Environment=FULL_LOGIN_COOLDOWN_MS=1800000
ExecStart=/usr/bin/node $APP/watcher.js
UMask=0077
TimeoutStopSec=420
KillMode=mixed
Restart=always
RestartSec=15
StandardOutput=append:/var/log/bukeala.log
StandardError=append:/var/log/bukeala.log

[Install]
WantedBy=multi-user.target
UNIT

chmod 600 /etc/systemd/system/bukeala.service
systemctl daemon-reload
systemctl enable --now bukeala-display.service
systemctl enable bukeala.service
systemctl restart bukeala.service
echo "=== Bukeala setup DONE $(date) ==="
systemctl status bukeala.service --no-pager || true
FOOTER

# Keep embedded Windows-edited sources identical to GCE metadata's LF text.
sed -i 's/\r$//' "$OUT"
echo "Generado $OUT ($(wc -c < "$OUT") bytes)"
