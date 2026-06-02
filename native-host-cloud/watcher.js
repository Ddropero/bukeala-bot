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
