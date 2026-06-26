/**
 * Bukeala Native Host — Cloud Watcher (Fly.io)
 *
 * Proceso long-running 24/7. Dos responsabilidades:
 *
 *  1. KEEP-ALIVE PROACTIVO: en horario laboral renueva cada PROACTIVE_INTERVAL_MS
 *     y empuja cookies nuevas al Worker. La sesión expira en ~10-15 min, así que
 *     renovar cada ~10 min la mantiene siempre viva. Usa un PERFIL PERSISTENTE
 *     de Chromium → reutiliza el TGC de CAS → la mayoría de renovaciones son sin
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
// Perfil persistente de Chromium (guarda el TGC de CAS entre corridas → la
// mayoría de renovaciones no usan captcha). Junto al código = sobrevive reinicios.
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, "chrome-profile");
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
    PROFILE_DIR,
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
      const via = r.usedCaptcha ? "captcha" : "TGC";
      log("info", "auto-login OK", { cookieCount: r.cookieCount, durationMs, reason, via });
      await reportEvent(c, { type: "ok", message: `${r.cookieCount} cookies (cloud, ${reason}, ${via})`, cookieCount: r.cookieCount, durationMs });
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

  // ESTRATEGIA (perfil persistente + TGC):
  // Renovar ya casi no cuesta captcha (el TGC del perfil reusa el SSO). Por eso
  // volvemos a un KEEP-ALIVE en horario laboral: renovar cada PROACTIVE_INTERVAL_MS
  // mantiene la sesión SIEMPRE viva → el paciente nunca espera. El captcha solo
  // se gasta cuando el TGC expira (cada varias horas), no en cada renovación.
  // Fuera de horario no renovamos (no hay pacientes + Bukeala hace limpieza
  // nocturna). On-demand sigue como respaldo inmediato.
  let lastMorningLoginDay = -1;          // día Bogotá del último login matutino
  let lastProactiveAt = Date.now();      // último keep-alive (el startup cuenta)

  while (true) {
    try {
      const now = new Date();
      const bogotaHour = (now.getUTCHours() - 5 + 24) % 24;
      const inBusinessHours = bogotaHour >= 7 && bogotaHour < 19;
      // "día Bogotá" para el throttle del login matutino
      const bogotaDay = new Date(now.getTime() - 5 * 3600 * 1000).getUTCDate();

      // 1. ¿Refresh on-demand pedido (por Telegram o por un WhatsApp entrante)?
      const req = await checkForRefreshRequest(c);
      if (req) {
        // De NOCHE (fuera de 7am-7pm): solo atendemos refrescos MANUALES del
        // doctor (/sesion_renew). Las solicitudes disparadas por un paciente
        // que escribió de madrugada se dejan en la cola — la VM no se despierta
        // por ellas; se procesarán a las 7am. Así ahorramos captcha de noche.
        const by = String(req.requestedBy || "");
        const isPatientTriggered = by.includes("wa-incoming") || by.includes("queue");
        const allow = inBusinessHours || !isPatientTriggered;
        if (allow) {
          log("info", "refresh requested", { by, at: req.requestedAt, inBusinessHours });
          const ok = await doLogin(c, "on-demand");
          await reportComplete(c, ok, ok ? "cloud login OK" : "cloud login failed");
        } else {
          log("info", "refresh diferido (nocturno, paciente) — queda pendiente hasta 7am", { by });
        }
      }

      // 2. Login matutino (7am Bogotá): primer toque del día. Si el TGC sigue
      //    vivo será sin captcha; si expiró de noche, aquí se renueva el TGC.
      if (bogotaHour === 7 && lastMorningLoginDay !== bogotaDay) {
        log("info", "login matutino (7am)");
        await doLogin(c, "morning");
        lastMorningLoginDay = bogotaDay;
        lastProactiveAt = Date.now();
      }

      // 3. KEEP-ALIVE: en horario laboral, renovar cada PROACTIVE_INTERVAL_MS
      //    para mantener la sesión siempre viva. Barato porque reusa el TGC.
      if (inBusinessHours && Date.now() - lastProactiveAt >= PROACTIVE_INTERVAL_MS) {
        log("info", "keep-alive (TGC)");
        await doLogin(c, "keep-alive");
        lastProactiveAt = Date.now();
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
