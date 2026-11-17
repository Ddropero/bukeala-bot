"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: sleep } = require("node:timers/promises");

const TIMED_OUT = Symbol("timed-out");
// Etapas de renew() que se aceptan en el reporte de cycle-timeout (copia de la
// lista cerrada de persistentSession.js: la etapa viaja al Worker y no puede
// ser texto libre).
const RENEW_STAGES = new Set(["profile", "navigation", "adoption", "verification", "full-login", "publication"]);
// Plazo del aviso de cycle-timeout: corto, porque tras él viene la salida y un
// Worker lento no puede volver a dejar colgado el proceso.
const CYCLE_TIMEOUT_REPORT_MS = 8000;

function numberOption(value, fallback, minimum) {
  const n = Number(value);
  return Number.isFinite(n) && n >= minimum ? n : fallback;
}

function safeResult(result) {
  return {
    ok: result?.ok === true,
    authenticated: result?.authenticated === true,
    published: result?.published === true,
    workerVerified: result?.workerVerified === true,
    loginAttempted: result?.loginAttempted === true,
    via: result?.via || "persistent",
    reasonCode: result?.reasonCode || null,
    // La URL (ya redactada por safeLocation en persistentSession) es el ÚNICO
    // dato que distingue un bloqueo del anti-bot de un redirect legítimo a un
    // host nuevo del portal. Se perdía aquí: el 24-25/oct/2026 hubo 101
    // "auth-challenge" sin saber a dónde nos desviaban, y la alerta de Telegram
    // del Worker (que busca "perfdrive") quedó muda por falta de este campo.
    postNavUrl: result?.postNavUrl || null,
  };
}

function createPersistentWatcher(env, options = {}) {
  if (!env.WORKER_URL || !env.CAPTURE_TOKEN) throw new Error("WORKER_URL y CAPTURE_TOKEN son obligatorios");
  const base = new URL(env.WORKER_URL);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("WORKER_URL debe ser HTTPS");
  base.pathname = base.pathname.replace(/\/capture\/?$/, "").replace(/\/$/, "");
  base.search = "";
  base.hash = "";
  const profileDir = env.BROWSER_PROFILE_DIR || path.join(os.homedir(), ".bukeala-browser");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const statusFile = path.join(profileDir, "watcher-status.json");
  const fetchImpl = options.fetch || fetch;
  const now = options.now || Date.now;
  const logger = options.log || ((level, message, meta = {}) =>
    console.log(JSON.stringify({ ts: new Date(now()).toISOString(), level, message, ...meta })));
  // El manager registra por env.log. Antes recibía process.env tal cual, así
  // que env.log nunca era función y TODO su registro era un no-op: del 10 al
  // 17/nov/2026 la VM quedó colgada sin una sola línea que dijera dónde. Se le
  // pasa una copia con el logger; el filtro de secretos vive en el manager.
  const manager = options.manager || require("./persistentSession").createPersistentSessionManager({
    ...env, log: (level, message, meta) => logger(level, message, meta),
  });
  const intervalMs = numberOption(env.PROACTIVE_INTERVAL_MS, 600000, 60000);
  const pollMs = numberOption(env.POLL_INTERVAL_MS, 30000, 1000);
  // PLAZO MÁXIMO POR CICLO. Un ciclo normal dura segundos (las navegaciones
  // tienen tope de 60 s y las peticiones de 15 s); 8 min es muy holgado. Sin
  // este tope, una promesa de Playwright que nunca resuelve dejó al proceso
  // "active" para systemd pero mudo durante 7 días (10-17/nov/2026).
  const cycleTimeoutMs = options.cycleTimeoutMs || numberOption(env.CYCLE_TIMEOUT_MS, 8 * 60000, 60000);
  // El vigilante interno da un margen extra para que, en un cuelgue dentro de
  // renew(), dispare primero el plazo envuelto (que conoce la etapa).
  const watchdogGraceMs = options.watchdogGraceMs ?? 2 * 60000;
  const watchdogEveryMs = options.watchdogIntervalMs || 60000;
  // Reloj del vigilante: monotónico en producción (un ajuste de NTP no debe
  // simular un cuelgue); en pruebas, el reloj inyectado.
  const monotonic = options.monotonic || options.now || (() => performance.now());
  // Inyectable para probar la salida sin matar el runner de pruebas.
  const exit = options.exit || ((code) => process.exit(code));
  // Código de salida distinto de 0: systemd (Restart=always, RestartSec=15)
  // levanta un proceso limpio con navegador nuevo; el estado en disco sigue.
  const CYCLE_TIMEOUT_EXIT_CODE = 3;
  let status = { version: 1, successfulCycles: 0, fullLogins: 0, failures: 0, nextAttemptAt: 0 };
  try {
    const previous = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    if (previous.version === 1) status = { ...status, ...previous };
  } catch { /* First boot or interrupted status file: profile itself remains authoritative. */ }
  status.startedAt = new Date(now()).toISOString();
  let inFlight = false;
  let closed = false;
  let reportingCompletion = false;
  // Qué está "en vuelo" y desde cuándo (reloj monotónico). Solo existe mientras
  // corre un tick o un ciclo: durante un backoff legítimo (hasta 60 min sin
  // hablar con el Worker) es null, así que el vigilante no puede confundirlo.
  let activity = null;
  let fatal = false;
  let watchdogTimer = null;
  const deadlineTimers = new Set();

  function persist() {
    const temp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(status, null, 2), { mode: 0o600 });
    fs.renameSync(temp, statusFile);
  }

  async function request(route, body, timeoutMs = 15000) {
    const response = await fetchImpl(`${base.href.replace(/\/$/, "")}${route}`, {
      method: body ? "POST" : "GET",
      headers: { "X-Capture-Token": env.CAPTURE_TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  }

  async function report(route, body, timeoutMs) {
    try { await request(route, body, timeoutMs); }
    catch { logger("warn", "telemetría no disponible", { route }); }
  }

  // Carrera contra un plazo SIN cancelar la promesa original (Playwright no
  // ofrece cancelación): si vence, devuelve TIMED_OUT y la promesa queda
  // huérfana; por eso tras un cycle-timeout el proceso se termina.
  function withDeadline(promise, ms) {
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
    deadlineTimers.add(timer);
    return Promise.race([promise, deadline]).finally(() => {
      clearTimeout(timer);
      deadlineTimers.delete(timer);
    });
  }

  /**
   * Un ciclo superó su plazo: el navegador quedó en un estado del que no sale
   * solo. Se reporta al Worker (con plazo corto propio: este aviso tampoco
   * puede colgarse) y se termina el proceso para que systemd lo reinicie. Así
   * la caída silenciosa de 7 días (10-17/nov/2026) pasa a durar minutos.
   */
  async function failCycleTimeout(origin) {
    if (fatal) return;
    fatal = true;
    closed = true; // proceso condenado: ningún ciclo nuevo sobre este navegador
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    // Los plazos pendientes del ciclo colgado ya no sirven (el proceso sale) y
    // no deben retener el bucle de eventos.
    for (const timer of deadlineTimers) clearTimeout(timer);
    deadlineTimers.clear();
    let stage = null;
    try { stage = typeof manager.getStage === "function" ? manager.getStage() : null; } catch { /* sin etapa */ }
    // Solo etapas de la lista cerrada: nada de texto libre hacia el Worker.
    if (!RENEW_STAGES.has(stage)) stage = null;
    const where = stage || activity?.name || "desconocida";
    logger("error", "ciclo excedió el plazo; reinicio del proceso", { origin, stage: where, cycleTimeoutMs });
    try {
      // Cuenta como falla: el proceso nuevo respeta un backoff corto (no de
      // autenticación) en vez de reintentar en bucle, y el estado sobrevive.
      status.failures++;
      status.nextAttemptAt = now() + retryMs({ reasonCode: "cycle-timeout" });
      status.nextScheduledAt = status.nextAttemptAt;
      status.lastCompletedAt = new Date(now()).toISOString();
      status.lastResult = { ...safeResult({ reasonCode: "cycle-timeout" }), stage: where };
      persist();
    } catch { /* el disco no debe impedir el reinicio */ }
    await withDeadline(report("/native-host/event", {
      type: "error",
      via: "persistent",
      at: new Date(now()).toISOString(),
      hadBukealaJsession: false,
      reasonCode: "cycle-timeout",
      stage: where,
      message: `persistent: cycle-timeout (etapa ${where}, ${origin})`,
    }, CYCLE_TIMEOUT_REPORT_MS), CYCLE_TIMEOUT_REPORT_MS + 2000);
    exit(CYCLE_TIMEOUT_EXIT_CODE);
  }

  // Vigilante INTERNO, aparte del plazo envuelto: cubre un cuelgue fuera de
  // renew() (telemetría, confirmación, persistencia asíncrona). Solo mira lo
  // que está en vuelo; en backoff `activity` es null y nunca dispara.
  function checkStuck() {
    if (fatal || !activity) return false;
    if (monotonic() - activity.since < cycleTimeoutMs + watchdogGraceMs) return false;
    failCycleTimeout(`watchdog-${activity.name}`).catch(() => exit(CYCLE_TIMEOUT_EXIT_CODE));
    return true;
  }

  async function flushCompletion() {
    const completion = status.completionOutbox;
    if (!completion || reportingCompletion || now() < (status.completionRetryAt || 0)) return;
    reportingCompletion = true;
    try {
      // Keep the result across restarts/network failures. A stale result is
      // acknowledged by the Worker without changing a different request.
      const acknowledgement = await request("/native-host/refresh-complete", completion);
      if (acknowledgement?.ok !== true) throw new Error("completion-not-acknowledged");
      if (status.completionOutbox === completion) {
        delete status.completionOutbox;
        delete status.completionRetryAt;
        persist();
      }
    } catch {
      status.completionRetryAt = now() + pollMs;
      persist();
      logger("warn", "confirmación de renovación pendiente");
    } finally {
      reportingCompletion = false;
    }
  }

  function retryMs(result) {
    // The session manager also persists its full-login cooldown across restarts.
    if (/captcha|blocked|credential|login|cooldown|challenge|config/i.test(result.reasonCode || "")) {
      return Math.min(3600000, 1800000 * Math.max(1, status.failures));
    }
    return Math.min(600000, 90000 * Math.max(1, status.failures));
  }

  async function runCycle(reason = "scheduled") {
    if (closed || inFlight) return { skipped: true, reason: "busy" };
    // A new process must reopen a healthy profile immediately, even if it
    // stopped during the previous success's short polling throttle. Failed
    // cycles retain their durable retry deadline, including on startup.
    const resumeHealthyProfile = reason === "startup" && status.failures === 0;
    if (now() < status.nextAttemptAt && !resumeHealthyProfile) return { skipped: true, reason: "backoff" };
    inFlight = true;
    const previousActivity = activity;
    activity = { name: "cycle", since: monotonic() };
    const completionRequest = status.pendingRequest || status.completionOutbox?.requestedAt;
    status.lastAttemptAt = new Date(now()).toISOString();
    let result;
    try {
      result = await withDeadline(Promise.resolve().then(() => manager.renew()), cycleTimeoutMs);
    } catch {
      result = { ok: false, authenticated: false, reasonCode: "cycle_exception" };
    }
    if (result === TIMED_OUT) {
      try { await failCycleTimeout("deadline"); }
      finally { inFlight = false; activity = previousActivity; }
      return { ...safeResult({ reasonCode: "cycle-timeout" }), stage: status.lastResult?.stage || null };
    }
    try {
      const summary = safeResult(result);
      // A browser that works alone is not yet a working Worker session.
      summary.ok = summary.ok && summary.authenticated && summary.published && summary.workerVerified;
      status.lastResult = summary;
      status.lastCompletedAt = new Date(now()).toISOString();
      if (summary.ok) {
        status.lastSuccessAt = status.lastCompletedAt;
        status.successfulCycles++;
        status.failures = 0;
        status.nextAttemptAt = now() + Math.min(pollMs, 30000);
        status.nextScheduledAt = now() + intervalMs;
      } else {
        status.failures++;
        status.nextAttemptAt = now() + retryMs(summary);
        status.nextScheduledAt = status.nextAttemptAt;
      }
      if (summary.loginAttempted && summary.authenticated) {
        status.fullLogins++;
        status.lastFullLoginAt = status.lastCompletedAt;
      }
      if (completionRequest) {
        status.completionOutbox = {
          requestedAt: completionRequest,
          completedAt: status.lastCompletedAt,
          ok: summary.ok,
          ...(summary.reasonCode ? { reasonCode: summary.reasonCode } : {}),
          nextAttemptAt: summary.ok ? undefined : status.nextAttemptAt,
          message: summary.ok ? "Sesión persistente verificada" : "La VM reintentará automáticamente",
        };
        delete status.completionRetryAt;
        if (summary.ok) {
          status.lastCompletedRequest = completionRequest;
          delete status.pendingRequest;
        } else {
          // A newer verification supersedes an undelivered old success, also
          // when a process restart discovers that the session no longer works.
          status.pendingRequest = completionRequest;
          if (status.lastCompletedRequest === completionRequest) delete status.lastCompletedRequest;
        }
      }
      persist();
      logger(summary.ok ? "info" : "warn", "ciclo persistente", { reason, ...summary });
      await report("/native-host/event", {
        type: summary.ok ? "ok" : "error",
        via: summary.via,
        at: status.lastCompletedAt,
        hadBukealaJsession: summary.authenticated,
        message: summary.ok ? "persistent: navegador y Worker verificados" : `persistent: ${summary.reasonCode || "unverified"}`,
        // El Worker ya declara, copia y persiste postNavUrl, y su alerta de
        // Radware lo concatena al mensaje: mandarlo revive esa alerta sin
        // tocar el Worker.
        ...(summary.postNavUrl ? { postNavUrl: summary.postNavUrl } : {}),
      });
      await flushCompletion();
      return summary;
    } finally {
      inFlight = false;
      activity = previousActivity;
    }
  }

  async function tick() {
    if (closed || inFlight) return;
    activity = { name: "tick", since: monotonic() };
    try {
      await flushCompletion();
      // El backoff se respeta tal cual (política deliberada, con pruebas): en
      // espera no se consulta al Worker. Por eso el Worker avisa al Dr. solo
      // tras 2 h sin eventos, muy por encima del backoff máximo de 60 min.
      if (now() < status.nextAttemptAt) return;
      let pending = null;
      try { pending = await request("/native-host/check-refresh"); }
      catch { logger("warn", "no se pudo leer orden remota"); }
      if (pending?.pending && typeof pending.requestedAt === "string" &&
          pending.requestedAt !== status.lastCompletedRequest) {
        status.lastRequest = pending.requestedAt;
        status.pendingRequest = pending.requestedAt;
        persist();
        await runCycle("on-demand");
        return;
      }
      if (now() >= (status.nextScheduledAt || 0)) await runCycle("scheduled");
    } finally {
      activity = null;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    // SIGTERM should finish the current cycle before Chromium flushes its profile.
    while (inFlight) await sleep(100);
    await manager.close();
    status.stoppedAt = new Date(now()).toISOString();
    persist();
  }

  async function run(signal) {
    // El vigilante arranca ANTES del primer ciclo: el de arranque también puede
    // colgarse. unref() para que el temporizador no mantenga vivo el proceso.
    if (!watchdogTimer && !closed) {
      watchdogTimer = setInterval(checkStuck, watchdogEveryMs);
      watchdogTimer.unref?.();
    }
    // Failed attempts keep their deadline; healthy profiles reopen immediately.
    await runCycle("startup");
    while (!signal?.aborted && !closed) {
      try { await sleep(pollMs, undefined, { signal }); }
      catch (error) { if (error.name === "AbortError") break; throw error; }
      if (!signal?.aborted) await tick();
    }
    await close();
  }
  return { run, runCycle, tick, close, checkStuck, getStatus: () => ({ ...status }) };
}

async function main(env = process.env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const watcher = createPersistentWatcher(env);
  try { await watcher.run(controller.signal); }
  finally {
    await watcher.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

module.exports = { createPersistentWatcher, safeResult, main };
if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ level: "error", message: "persistent watcher stopped unexpectedly" }));
    process.exitCode = 2;
  });
}
