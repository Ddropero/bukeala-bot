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

cat > $APP/package.json <<'PKGEOF'
{
  "name": "bukeala-native-host-cloud",
  "version": "1.0.0",
  "description": "Bukeala session keeper 24/7 en Fly.io (sin PC/Mac prendido)",
  "private": true,
  "scripts": {
    "start": "node watcher.js"
  },
  "dependencies": {
    "playwright": "^1.59.1",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2"
  },
  "engines": {
    "node": ">=18"
  }
}

PKGEOF

cat > $APP/autoLogin.js <<'ALEOF'
/**
 * Auto-login flow para la NUBE (Fly.io).
 *
 * Diferencia clave vs Windows/Mac: las credenciales NO se cifran en disco.
 * Vienen directo de variables de entorno (Fly secrets), que ya están
 * cifradas en reposo por la plataforma. Así no hay master key ni creds.dat.
 *
 * Env vars requeridas:
 *   CAS_USERNAME          usuario CAS Colsanitas (ej. 80040718.prest)
 *   CAS_PASSWORD          password CAS
 *   TWO_CAPTCHA_API_KEY   key de 2Captcha
 *   CAPTURE_TOKEN         token compartido con el Worker
 *   WORKER_URL            https://bukeala-bot.ddropero.workers.dev/capture
 *
 * Flow idéntico al de siempre:
 *   Chromium headless stealth → CAS → user+pass → reCAPTCHA (2Captcha)
 *   → submit → bind /keraltyadscritos → captura cookies → push al Worker.
 */
const path = require("node:path");
const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

try { chromium.use(StealthPlugin()); } catch { /* already applied */ }

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const TWO_CAPTCHA_POLL_INTERVAL_MS = 5000;
const TWO_CAPTCHA_MAX_WAIT_MS = 120 * 1000;

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

const CONTEXT_OPTIONS = {
  viewport: { width: 1366, height: 800 },
  locale: "es-CO",
  timezoneId: "America/Bogota",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "es-CO,es;q=0.9,en;q=0.8" },
};

async function solveRecaptcha(twoCaptchaKey, sitekey, pageUrl, log) {
  log("info", "submitting reCAPTCHA to 2Captcha", { sitekey, pageUrl });
  const submitParams = new URLSearchParams({
    key: twoCaptchaKey,
    method: "userrecaptcha",
    googlekey: sitekey,
    pageurl: pageUrl,
    json: "1",
  });
  const subRes = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${submitParams}`);
  const subJson = await subRes.json();
  if (subJson.status !== 1) {
    throw new Error(`2Captcha submit failed: ${subJson.request ?? "unknown"}`);
  }
  const captchaId = subJson.request;
  log("info", "2Captcha task created", { captchaId });

  const startedAt = Date.now();
  while (Date.now() - startedAt < TWO_CAPTCHA_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, TWO_CAPTCHA_POLL_INTERVAL_MS));
    const pollRes = await fetch(
      `${TWO_CAPTCHA_BASE}/res.php?key=${twoCaptchaKey}&action=get&id=${captchaId}&json=1`,
    );
    const pollJson = await pollRes.json();
    if (pollJson.status === 1) {
      log("info", "2Captcha solved", { elapsedMs: Date.now() - startedAt });
      return pollJson.request;
    }
    if (pollJson.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha poll failed: ${pollJson.request}`);
    }
  }
  throw new Error("2Captcha timeout (>2 min)");
}

/**
 * @param {object} env  { CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY,
 *                        CAPTURE_TOKEN, WORKER_URL, APP_DIR, log }
 */
async function runAutoLogin(env) {
  const {
    CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY,
    CAPTURE_TOKEN, WORKER_URL, APP_DIR, log,
  } = env;

  if (!CAS_USERNAME || !CAS_PASSWORD) return { ok: false, reason: "CAS_USERNAME/CAS_PASSWORD missing" };
  if (!TWO_CAPTCHA_API_KEY) return { ok: false, reason: "TWO_CAPTCHA_API_KEY missing" };
  if (!CAPTURE_TOKEN || !WORKER_URL) return { ok: false, reason: "CAPTURE_TOKEN/WORKER_URL missing" };

  const creds = { username: CAS_USERNAME, password: CAS_PASSWORD };
  log("info", "credentials from env", { user: creds.username });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();

  let result = { ok: false };

  try {
    log("info", "navigating to Bukeala");
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);
    const url = page.url();
    log("info", "after navigation", { url });

    if (url.includes("appoint.tuscitasmedicas.com") && !url.includes("/cas/login")) {
      log("info", "session already alive, skipping login");
    } else {
      log("info", "at CAS login, filling credentials");
      const userSel = 'input[name="username"], input#username';
      const passSel = 'input[name="password"], input#password';
      const submitSel = 'button[type="submit"], input[type="submit"], button[name="submit"]';

      await page.waitForSelector(userSel, { timeout: 30_000 });
      await page.fill(userSel, creds.username);
      await page.fill(passSel, creds.password);

      const sitekey = await page
        .$eval(".g-recaptcha, [data-sitekey]", (el) => el.getAttribute("data-sitekey"))
        .catch(() => null);

      if (sitekey) {
        log("info", "reCAPTCHA detected", { sitekey });
        const token = await solveRecaptcha(TWO_CAPTCHA_API_KEY, sitekey, page.url(), log);
        await page.evaluate((t) => {
          let el = document.getElementById("g-recaptcha-response");
          if (!el) {
            el = document.createElement("textarea");
            el.id = "g-recaptcha-response";
            el.name = "g-recaptcha-response";
            el.style.display = "none";
            document.body.appendChild(el);
          }
          el.value = t;
          el.innerHTML = t;
          if (typeof window.___grecaptcha_cfg !== "undefined" && window.___grecaptcha_cfg.clients) {
            const clients = window.___grecaptcha_cfg.clients;
            for (const cid in clients) {
              for (const k in clients[cid]) {
                if (typeof clients[cid][k] === "object") {
                  for (const k2 in clients[cid][k]) {
                    if (
                      typeof clients[cid][k][k2] === "object" &&
                      clients[cid][k][k2] &&
                      typeof clients[cid][k][k2].callback === "function"
                    ) {
                      try { clients[cid][k][k2].callback(t); } catch {}
                    }
                  }
                }
              }
            }
          }
        }, token);
        log("info", "reCAPTCHA token injected");
      } else {
        log("info", "no reCAPTCHA detected, submitting directly");
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
        page.click(submitSel),
      ]);
      await page.waitForTimeout(2500);

      const finalUrl = page.url();
      log("info", "after submit", { url: finalUrl });

      if (finalUrl.includes("/cas/login") && !finalUrl.includes("ticket=")) {
        const errorText = await page
          .locator(".alert-danger, .errors, .login-error")
          .first().textContent().catch(() => null);
        throw new Error(`Login failed (still at CAS): ${errorText ?? "unknown"}`);
      }
    }

    // Bind del JSESSIONID de /keraltyadscritos
    if (!page.url().includes("/keraltyadscritos/")) {
      log("info", "post-login en otra app, navegando a /keraltyadscritos");
      try {
        await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(1500);
        log("info", "ahora en", { url: page.url() });
      } catch (e) {
        log("warn", "navegación falló (continuo igual)", { error: e.message });
      }
    }

    try {
      const verifyResp = await page.evaluate(async () => {
        const r = await fetch("/keraltyadscritos/findCustomer", {
          credentials: "include", redirect: "manual",
        });
        return { status: r.status, type: r.type, ok: r.ok };
      });
      log("info", "verificación /keraltyadscritos", verifyResp);
    } catch (e) {
      log("warn", "verificación falló (no bloqueante)", { error: e.message });
    }

    const cookies = await context.cookies();
    const filtered = cookies.filter((c) => {
      const d = (c.domain || "").toLowerCase();
      return d.includes("tuscitasmedicas.com") || d.includes("colsanitas.com");
    });
    if (filtered.length === 0) throw new Error("No relevant cookies captured");

    const payload = {
      capturedAt: new Date().toISOString(),
      cookies: filtered.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires === -1 ? undefined : c.expires,
        httpOnly: c.httpOnly,
      })),
    };

    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": CAPTURE_TOKEN },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Worker rejected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);

    log("info", "session pushed to worker", { status: res.status, cookieCount: filtered.length });
    result = { ok: true, cookieCount: filtered.length };
  } catch (e) {
    log("error", "auto-login failed", { error: e.message });
    try {
      if (APP_DIR) await page.screenshot({ path: path.join(APP_DIR, "last-error.png"), fullPage: true });
    } catch {/* ignore */}
    result = { ok: false, reason: e.message };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

module.exports = { runAutoLogin };

ALEOF

cat > $APP/watcher.js <<'WEOF'
/**
 * Bukeala Native Host — Cloud Watcher (Fly.io)
 *
 * Proceso long-running 24/7. Dos responsabilidades:
 *
 *  1. KEEP-ALIVE PROACTIVO: cada PROACTIVE_INTERVAL_MS hace un auto-login
 *     fresco y empuja cookies nuevas al Worker. Como la sesión de Bukeala
 *     expira sola en ~10-15 min, renovar cada ~10 min la mantiene siempre viva.
 *
 *  2. ON-DEMAND: cada POLL_INTERVAL_MS consulta /native-host/check-refresh.
 *     Si alguien pidió /sesion_renew por Telegram, hace login inmediato.
 *
 * A diferencia de Windows/Mac, NO hace spawn de un proceso hijo: llama
 * runAutoLogin() en el mismo proceso (un solo contenedor, más simple).
 *
 * Credenciales y config 100% por env vars (Fly secrets):
 *   CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL
 * Opcionales:
 *   POLL_INTERVAL_MS        (default 30000  = 30s)
 *   PROACTIVE_INTERVAL_MS   (default 600000 = 10 min)
 */
const os = require("node:os");
const { runAutoLogin } = require("./autoLogin");

const APP_DIR = os.tmpdir(); // solo para screenshots de error
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const PROACTIVE_INTERVAL_MS = parseInt(process.env.PROACTIVE_INTERVAL_MS || "600000", 10);

function log(level, msg, meta = {}) {
  // Fly captura stdout → `flyctl logs`. JSON de una línea para grep fácil.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
}

function cfg() {
  const c = {
    CAS_USERNAME: process.env.CAS_USERNAME,
    CAS_PASSWORD: process.env.CAS_PASSWORD,
    TWO_CAPTCHA_API_KEY: process.env.TWO_CAPTCHA_API_KEY,
    CAPTURE_TOKEN: process.env.CAPTURE_TOKEN,
    WORKER_URL: process.env.WORKER_URL,
    APP_DIR,
    log,
  };
  const missing = ["CAS_USERNAME", "CAS_PASSWORD", "TWO_CAPTCHA_API_KEY", "CAPTURE_TOKEN", "WORKER_URL"]
    .filter((k) => !c[k]);
  if (missing.length) throw new Error(`Faltan env vars: ${missing.join(", ")}`);
  return c;
}

function baseUrl(workerUrl) {
  // WORKER_URL llega como .../capture; derivamos la raíz
  return workerUrl.replace(/\/capture$/, "");
}

async function checkForRefreshRequest(c) {
  const url = `${baseUrl(c.WORKER_URL)}/native-host/check-refresh`;
  try {
    const res = await fetch(url, { method: "GET", headers: { "X-Capture-Token": c.CAPTURE_TOKEN } });
    if (!res.ok) { log("warn", "check-refresh non-OK", { status: res.status }); return null; }
    const data = await res.json();
    return data.pending ? data : null;
  } catch (e) {
    log("warn", "check-refresh fetch failed", { error: e.message });
    return null;
  }
}

async function reportComplete(c, ok, message) {
  const url = `${baseUrl(c.WORKER_URL)}/native-host/refresh-complete`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": c.CAPTURE_TOKEN },
      body: JSON.stringify({ ok, message }),
    });
  } catch (e) {
    log("warn", "report-complete failed", { error: e.message });
  }
}

async function reportEvent(c, event) {
  const url = `${baseUrl(c.WORKER_URL)}/native-host/event`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": c.CAPTURE_TOKEN },
      body: JSON.stringify({ at: new Date().toISOString(), ...event }),
    });
  } catch (e) {
    log("warn", "event report failed", { error: e.message });
  }
}

let loginInFlight = false;

async function doLogin(c, reason) {
  if (loginInFlight) { log("info", "login already in flight, skip", { reason }); return; }
  loginInFlight = true;
  const startedAt = Date.now();
  try {
    log("info", "auto-login start", { reason });
    const r = await runAutoLogin(c);
    const durationMs = Date.now() - startedAt;
    if (r.ok) {
      log("info", "auto-login OK", { cookieCount: r.cookieCount, durationMs, reason });
      await reportEvent(c, { type: "ok", message: `${r.cookieCount} cookies (cloud, ${reason})`, cookieCount: r.cookieCount, durationMs });
    } else {
      log("error", "auto-login FAIL", { reason: r.reason, durationMs });
      await reportEvent(c, { type: "error", message: `${r.reason} (cloud, ${reason})`, durationMs });
    }
    return r.ok;
  } finally {
    loginInFlight = false;
  }
}

async function main() {
  const c = cfg();
  log("info", "cloud watcher started", {
    worker: c.WORKER_URL,
    user: c.CAS_USERNAME,
    pollMs: POLL_INTERVAL_MS,
    proactiveMs: PROACTIVE_INTERVAL_MS,
  });

  // Login inmediato al arrancar (sesión fresca de una)
  await doLogin(c, "startup");

  let lastProactive = Date.now();

  while (true) {
    try {
      // 1. ¿Refresh on-demand pedido por Telegram?
      const req = await checkForRefreshRequest(c);
      if (req) {
        log("info", "refresh requested", { by: req.requestedBy, at: req.requestedAt });
        const ok = await doLogin(c, "on-demand");
        await reportComplete(c, ok, ok ? "cloud login OK" : "cloud login failed");
      }

      // 2. ¿Toca keep-alive proactivo?
      if (Date.now() - lastProactive >= PROACTIVE_INTERVAL_MS) {
        await doLogin(c, "proactive");
        lastProactive = Date.now();
      }
    } catch (e) {
      log("error", "tick failed", { error: e.message });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  log("error", "fatal", { error: err.message, stack: err.stack });
  process.exit(2);
});

WEOF

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
Environment=PROACTIVE_INTERVAL_MS=600000
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
