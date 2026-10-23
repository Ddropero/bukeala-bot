"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: sleep } = require("node:timers/promises");

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
  const manager = options.manager || require("./persistentSession").createPersistentSessionManager(env);
  const fetchImpl = options.fetch || fetch;
  const now = options.now || Date.now;
  const logger = options.log || ((level, message, meta = {}) =>
    console.log(JSON.stringify({ ts: new Date(now()).toISOString(), level, message, ...meta })));
  const intervalMs = numberOption(env.PROACTIVE_INTERVAL_MS, 600000, 60000);
  const pollMs = numberOption(env.POLL_INTERVAL_MS, 30000, 1000);
  let status = { version: 1, successfulCycles: 0, fullLogins: 0, failures: 0, nextAttemptAt: 0 };
  try {
    const previous = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    if (previous.version === 1) status = { ...status, ...previous };
  } catch { /* First boot or interrupted status file: profile itself remains authoritative. */ }
  status.startedAt = new Date(now()).toISOString();
  let inFlight = false;
  let closed = false;
  let reportingCompletion = false;

  function persist() {
    const temp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(status, null, 2), { mode: 0o600 });
    fs.renameSync(temp, statusFile);
  }

  async function request(route, body) {
    const response = await fetchImpl(`${base.href.replace(/\/$/, "")}${route}`, {
      method: body ? "POST" : "GET",
      headers: { "X-Capture-Token": env.CAPTURE_TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  }

  async function report(route, body) {
    try { await request(route, body); }
    catch { logger("warn", "telemetría no disponible", { route }); }
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
    const completionRequest = status.pendingRequest || status.completionOutbox?.requestedAt;
    status.lastAttemptAt = new Date(now()).toISOString();
    let result;
    try {
      result = await manager.renew();
    } catch {
      result = { ok: false, authenticated: false, reasonCode: "cycle_exception" };
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
      });
      await flushCompletion();
      return summary;
    } finally {
      inFlight = false;
    }
  }

  async function tick() {
    if (closed || inFlight) return;
    await flushCompletion();
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
  }

  async function close() {
    if (closed) return;
    closed = true;
    // SIGTERM should finish the current cycle before Chromium flushes its profile.
    while (inFlight) await sleep(100);
    await manager.close();
    status.stoppedAt = new Date(now()).toISOString();
    persist();
  }

  async function run(signal) {
    // Failed attempts keep their deadline; healthy profiles reopen immediately.
    await runCycle("startup");
    while (!signal?.aborted && !closed) {
      try { await sleep(pollMs, undefined, { signal }); }
      catch (error) { if (error.name === "AbortError") break; throw error; }
      if (!signal?.aborted) await tick();
    }
    await close();
  }
  return { run, runCycle, tick, close, getStatus: () => ({ ...status }) };
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
