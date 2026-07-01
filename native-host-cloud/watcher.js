/**
 * Bukeala Native Host — Cloud Watcher (Fly.io)
 *
 * Proceso long-running 24/7. Dos responsabilidades:
 *
 *  1. KEEP-ALIVE PROACTIVO 24/7: renueva cada PROACTIVE_INTERVAL_MS a cualquier
 *     hora y empuja cookies nuevas al Worker. La sesión expira en ~10-15 min, así que
 *     renovar cada ~10 min la mantiene siempre viva. Guarda/restaura cookies con
 *     storageState (incluido el TGC de CAS) → la mayoría de renovaciones son sin
 *     reCAPTCHA (rápidas y casi gratis). El captcha solo se gasta cuando el TGC
 *     expira (cada varias horas).
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
const path = require("node:path");
const { runAutoLogin } = require("./autoLogin");

const APP_DIR = os.tmpdir(); // solo para screenshots de error
// Archivo de cookies (storageState). Guarda el TGC de CAS entre renovaciones →
// la mayoría no usan captcha. /tmp siempre escribible (sin líos de permisos).
// Solo guarda la cookie TGC (no el estado completo). Nombre nuevo a propósito:
// ignora cualquier bukeala-state.json viejo (estado completo que envenenaba).
const STATE_FILE = process.env.STATE_FILE || path.join(os.tmpdir(), "bukeala-tgc.json");
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
    STATE_FILE,
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
  if (loginInFlight) { log("info", "login already in flight, skip", { reason }); return "skipped"; }
  loginInFlight = true;
  const startedAt = Date.now();
  try {
    log("info", "auto-login start", { reason });
    const r = await runAutoLogin(c);
    const durationMs = Date.now() - startedAt;
    if (r.ok) {
      // via real reportado por autoLogin: tgc | captcha | captcha-fallback
      const via = r.via || (r.usedCaptcha ? "captcha" : "tgc");
      const tag = via + (r.fellBack ? "+fallback" : "");
      log("info", "auto-login OK", { cookieCount: r.cookieCount, durationMs, reason, via, fellBack: r.fellBack, url: r.postNavUrl });
      await reportEvent(c, {
        type: "ok", message: `${r.cookieCount} cookies (cloud, ${reason}, ${tag})`,
        cookieCount: r.cookieCount, durationMs,
        via, fellBack: !!r.fellBack, hadBukealaJsession: !!r.hadBukealaJsession, postNavUrl: r.postNavUrl,
      });
    } else {
      log("error", "auto-login FAIL", { reason: r.reason, durationMs, via: r.via, url: r.postNavUrl });
      await reportEvent(c, {
        type: "error", message: `${r.reason} (cloud, ${reason}, via=${r.via || "?"})`,
        durationMs, via: r.via, fellBack: !!r.fellBack, hadBukealaJsession: !!r.hadBukealaJsession, postNavUrl: r.postNavUrl,
      });
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

  // ESTRATEGIA 24/7 (storageState + TGC):
  // Renovar ya casi no cuesta captcha (se reusa el TGC vía storageState). Por eso
  // mantenemos la sesión viva TODO EL DÍA: keep-alive cada PROACTIVE_INTERVAL_MS,
  // sin importar la hora. El captcha solo se gasta cuando el TGC expira (cada
  // varias horas o tras la limpieza nocturna de Bukeala). Las solicitudes
  // on-demand se atienden a cualquier hora (también pacientes de madrugada).
  // NOTA: de noche Bukeala puede hacer mantenimiento e invalidar la sesión; en
  // ese caso algunas renovaciones nocturnas pueden fallar/usar captcha. Es un
  // experimento — vigilar con el tool MCP estado_sistema.
  let lastProactiveAt = Date.now();   // último keep-alive EXITOSO (el startup cuenta)
  let lastAttemptAt = Date.now();     // último INTENTO (éxito o fallo)
  let renewFailing = false;           // true si el último intento falló → reintentar pronto
  const RETRY_DELAY_MS = 90 * 1000;   // tras un fallo, reintentar en 90s (no esperar el intervalo)

  while (true) {
    try {
      // 1. ¿Refresh on-demand pedido (Telegram, WhatsApp entrante, MCP)?
      //    24/7: se atiende a cualquier hora (también pacientes de madrugada).
      const req = await checkForRefreshRequest(c);
      if (req) {
        log("info", "refresh requested", { by: String(req.requestedBy || ""), at: req.requestedAt });
        const r = await doLogin(c, "on-demand");
        // "skipped" = ya había un login en curso (no es un fallo) → no reportar error.
        if (r !== "skipped") await reportComplete(c, !!r, r ? "cloud login OK" : "cloud login failed");
        if (r === true) { lastProactiveAt = Date.now(); lastAttemptAt = Date.now(); renewFailing = false; }
      }

      // 2. KEEP-ALIVE 24/7 con REINTENTO tras fallo: renovar cada
      //    PROACTIVE_INTERVAL_MS; pero si el último intento falló (timeout de
      //    2Captcha, "fetch failed", etc.), reintentar a los RETRY_DELAY_MS en
      //    vez de esperar el intervalo completo → evita huecos largos de agenda.
      const intervalDue = Date.now() - lastProactiveAt >= PROACTIVE_INTERVAL_MS;
      const retryDue = renewFailing && (Date.now() - lastAttemptAt >= RETRY_DELAY_MS);
      if (intervalDue || retryDue) {
        log("info", retryDue ? "keep-alive (reintento tras fallo)" : "keep-alive");
        const res = await doLogin(c, "keep-alive");
        lastAttemptAt = Date.now();
        if (res === true) { lastProactiveAt = Date.now(); renewFailing = false; }
        else if (res === false) { renewFailing = true; } // reintenta en 90s
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
