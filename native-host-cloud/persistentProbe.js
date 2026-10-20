"use strict";

// This diagnostic never publishes a session or invokes messaging endpoints.
// --seed-worker is explicit migration only; normal tests never import cookies.
const fs = require("node:fs");
const { createPersistentSessionManager } = require("./persistentSession");
const { safeResult } = require("./persistentWatcher");

async function main() {
  if (!process.env.BROWSER_PROFILE_DIR) throw new Error("BROWSER_PROFILE_DIR required");
  const seed = process.argv.includes("--seed-worker");
  const restart = process.argv.includes("--restart");
  const allowLogin = process.argv.includes("--allow-login");
  const simulateSso = process.argv.includes("--simulate-sso-expiry");
  const simulateExpiry = simulateSso || process.argv.includes("--simulate-app-expiry");
  if (simulateSso && !allowLogin) throw new Error("SSO expiry simulation requires --allow-login");
  const results = [];
  let manager;
  try {
    manager = createPersistentSessionManager(process.env, { publish: false, expiryProbe: simulateExpiry });
    if (seed) {
      const base = process.env.WORKER_URL.replace(/\/capture\/?$/, "");
      const response = await fetch(`${base}/native-host/session`, {
        headers: { "X-Capture-Token": process.env.CAPTURE_TOKEN },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("seed-fetch-failed");
      const snapshot = await response.json();
      const seeded = await manager.seedCookies(snapshot.cookies, { capturedAt: snapshot.capturedAt });
      results.push({ phase: "explicit-migration", ok: seeded.ok, reasonCode: seeded.reasonCode || null });
      if (!seeded.ok) return results;
    }
    const first = await manager.renew({ allowFullLogin: allowLogin });
    results.push({ phase: "initial", ...safeResult(first) });
    let last = first;
    if (simulateExpiry && first.authenticated) {
      const reset = await manager.simulateAppSessionLoss({ includeSso: simulateSso });
      last = await manager.renew({ allowFullLogin: allowLogin });
      results.push({ phase: simulateSso ? "after-controlled-sso-session-loss" : "after-controlled-app-session-loss",
        ...reset, ...safeResult(last) });
    }
    await manager.close();
    manager = null;
    if (restart && last.authenticated) {
      manager = createPersistentSessionManager(process.env, { publish: false });
      const restored = await manager.renew({ allowFullLogin: false });
      results.push({ phase: "after-browser-restart", ...safeResult(restored) });
    }
    return results;
  } catch {
    results.push({ phase: "probe-error", ok: false, reasonCode: "probe-failed" });
    return results;
  } finally {
    if (manager) {
      try { await manager.close(); }
      catch { results.push({ phase: "browser-close", ok: false, reasonCode: "browser-close-failed" }); }
    }
    const report = {
      at: new Date().toISOString(),
      workerWrites: 0,
      importedWorkerSession: seed,
      fullLoginAllowed: allowLogin,
      expirySimulation: simulateSso ? "local-application-and-cas-cookie-removal"
        : simulateExpiry ? "local-application-cookie-removal" : null,
      results,
    };
    // Report is inside the protected profile and contains no cookies/credentials.
    if (fs.existsSync(process.env.BROWSER_PROFILE_DIR)) {
      fs.writeFileSync(`${process.env.BROWSER_PROFILE_DIR}/probe-result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    if (!results.length || results.some(result => !result.ok)) process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ ok: false, reasonCode: "probe-failed" }));
    process.exitCode = 1;
  });
}
