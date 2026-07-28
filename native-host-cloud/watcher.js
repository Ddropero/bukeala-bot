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
// Archivo del TGC de CAS entre renovaciones → la mayoría no usan captcha.
// Vive en el HOME (persiste reboots — /tmp se borraba al reiniciar la VM y
// cada reboot costaba un captcha). Solo guarda la cookie TGC, no el estado
// completo (el estado completo envenenaba la sesión — lección jun 2026).
const STATE_FILE = process.env.STATE_FILE || path.join(os.homedir(), ".bukeala-tgc.json");
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
      const tag = via + (r.fellBack ? "+fallback" : "") + (r.tgcSource === "worker" ? "+tgcWorker" : "");
      log("info", "auto-login OK", { cookieCount: r.cookieCount, durationMs, reason, via, fellBack: r.fellBack, tgcSource: r.tgcSource, url: r.postNavUrl });
      await reportEvent(c, {
        type: "ok", message: `${r.cookieCount} cookies (cloud, ${reason}, ${tag})`,
        cookieCount: r.cookieCount, durationMs,
        via, fellBack: !!r.fellBack, hadBukealaJsession: !!r.hadBukealaJsession, postNavUrl: r.postNavUrl,
        tgcSource: r.tgcSource || undefined,
      });
    } else {
      log("error", "auto-login FAIL", { reason: r.reason, durationMs, via: r.via, url: r.postNavUrl });
      await reportEvent(c, {
        type: "error", message: `${r.reason} (cloud, ${reason}, via=${r.via || "?"})`,
        durationMs, via: r.via, fellBack: !!r.fellBack, hadBukealaJsession: !!r.hadBukealaJsession, postNavUrl: r.postNavUrl,
        tgcSource: r.tgcSource || undefined,
      });
    }
    return r;
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

  // ESTRATEGIA 24/7 (TGC persistente):
  // Renovar casi nunca cuesta captcha (se reusa el TGC del archivo en HOME o,
  // si se perdió, se rescata del Worker). Keep-alive cada PROACTIVE_INTERVAL_MS
  // a toda hora; on-demand a cualquier hora. El captcha solo se gasta cuando
  // el TGC de CAS expira de verdad.
  let lastProactiveAt = Date.now();   // último keep-alive EXITOSO (el startup cuenta)
  let lastAttemptAt = Date.now();     // último INTENTO (éxito o fallo)
  let renewFailing = false;           // true si el último intento falló → reintentar con backoff
  let consecutiveFails = 0;           // fallos seguidos (escala el backoff)
  let fatalReason = null;             // p.ej. ZERO_BALANCE → backoff largo (requiere humano)
  const RETRY_DELAY_MS = 90 * 1000;   // tras un fallo normal, reintentar en 90s
  // Errores que NO se arreglan reintentando (requieren acción humana, p.ej. recargar saldo):
  const FATAL_PATTERNS = [/ZERO_BALANCE/i];

  // Delay del próximo reintento tras fallo. Normal: 90s. Fallos repetidos
  // (5+): 10 min — martillar cada 90s nos ganó "Too Many Requests" de
  // 2Captcha/CAS. Fatal (sin saldo): escalera 15 → 30 → 60 min.
  function retryDelayMs() {
    if (fatalReason) {
      const ladder = [15, 30, 60];
      return ladder[Math.min(Math.max(consecutiveFails - 1, 0), ladder.length - 1)] * 60 * 1000;
    }
    if (consecutiveFails >= 5) return 10 * 60 * 1000;
    return RETRY_DELAY_MS;
  }

  function noteResult(r) {
    if (r === "skipped") return;
    if (r && r.ok) {
      lastProactiveAt = Date.now();
      renewFailing = false; consecutiveFails = 0; fatalReason = null;
      return;
    }
    renewFailing = true;
    consecutiveFails += 1;
    const reason = (r && r.reason) || "";
    fatalReason = FATAL_PATTERNS.some((p) => p.test(reason)) ? reason : null;
    if (fatalReason) {
      log("error", "fallo FATAL — backoff largo hasta acción humana", {
        reason: fatalReason,
        nextRetryMin: Math.round(retryDelayMs() / 60000),
      });
    }
  }

  // Login inmediato al arrancar (sesión fresca de una)
  noteResult(await doLogin(c, "startup"));

  while (true) {
    try {
      // 1. ¿Refresh on-demand pedido (Telegram, WhatsApp entrante, MCP)?
      //    24/7 y SIN backoff: siempre se intenta ya — un humano pudo haber
      //    recargado el saldo y /sesion_renew debe funcionar de inmediato.
      const req = await checkForRefreshRequest(c);
      if (req) {
        log("info", "refresh requested", { by: String(req.requestedBy || ""), at: req.requestedAt });
        const r = await doLogin(c, "on-demand");
        // "skipped" = ya había un login en curso (no es un fallo) → no reportar error.
        if (r !== "skipped") await reportComplete(c, !!(r && r.ok), r && r.ok ? "cloud login OK" : "cloud login failed");
        lastAttemptAt = Date.now();
        noteResult(r);
      }

      // 2. KEEP-ALIVE con backoff. OJO: mientras renewFailing, el intervalo
      //    normal NO dispara (antes sí: lastProactiveAt solo avanza con éxito,
      //    así que tras 10 min fallando se intentaba en CADA tick de 30s —
      //    esa fue la tormenta de reintentos del 28/jul).
      const intervalDue = !renewFailing && Date.now() - lastProactiveAt >= PROACTIVE_INTERVAL_MS;
      const retryDue = renewFailing && Date.now() - lastAttemptAt >= retryDelayMs();
      if (intervalDue || retryDue) {
        log("info", retryDue ? `keep-alive (reintento tras ${consecutiveFails} fallo(s))` : "keep-alive");
        const res = await doLogin(c, "keep-alive");
        lastAttemptAt = Date.now();
        noteResult(res);
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
