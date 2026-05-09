/**
 * Bukeala Native Host — Refresh Watcher
 *
 * Polls the Worker every 30s for `/sesion_renew` requests from Telegram.
 * When a request is detected, spawns `node index.js --setup` so whoever is
 * at the consultorio PC can complete the login (visible Chromium window).
 *
 * After the setup process exits, reports back to the worker so the requester
 * gets a Telegram confirmation.
 *
 * Run modes:
 *   node watcher.js           — runs forever (use with Task Scheduler "at startup")
 *   node watcher.js --once    — single check, useful for testing
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

// Robust path resolution: APPDATA is sometimes missing under Task Scheduler.
// Fall back to USERPROFILE\AppData\Roaming, then to homedir.
function resolveAppDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "BukealaBot");
  if (process.env.USERPROFILE)
    return path.join(process.env.USERPROFILE, "AppData", "Roaming", "BukealaBot");
  return path.join(os.homedir(), "AppData", "Roaming", "BukealaBot");
}
const APP_DIR = resolveAppDir();
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const LOG_PATH = path.join(APP_DIR, "watcher.log");
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

function log(level, msg, meta = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  console.log(entry);
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, entry + "\n", "utf8");
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > 500_000) {
      const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
      fs.writeFileSync(LOG_PATH, lines.slice(-300).join("\n"), "utf8");
    }
  } catch {
    // ignore
  }
}

function readConfig() {
  // Priority order:
  //  1. CLI args (--worker / --token) — most reliable under Scheduled Task
  //  2. Env vars (BUKEALA_WORKER_URL / BUKEALA_CAPTURE_TOKEN)
  //  3. config.json in APP_DIR
  const argv = process.argv.slice(2);
  const argMap = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      argMap.set(argv[i].slice(2), argv[i + 1]);
      i++;
    }
  }

  const fromArgs = argMap.has("worker") && argMap.has("token");
  if (fromArgs) {
    return { workerUrl: argMap.get("worker"), captureToken: argMap.get("token") };
  }

  if (process.env.BUKEALA_WORKER_URL && process.env.BUKEALA_CAPTURE_TOKEN) {
    return {
      workerUrl: process.env.BUKEALA_WORKER_URL,
      captureToken: process.env.BUKEALA_CAPTURE_TOKEN,
    };
  }

  // Fallback to config.json
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    let dirListing = "";
    try {
      dirListing = fs.readdirSync(APP_DIR).join(", ");
    } catch (e) {
      dirListing = `dir read failed: ${e.message}`;
    }
    log("error", "config.json read failed; pass --worker and --token CLI args", {
      configPath: CONFIG_PATH,
      appDir: APP_DIR,
      appDirContents: dirListing,
      readError: err.message,
    });
    throw new Error(
      `config not provided. Pass --worker URL --token TOKEN or set BUKEALA_WORKER_URL + BUKEALA_CAPTURE_TOKEN env vars. ${err.message}`,
    );
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const cfg = JSON.parse(raw);
  if (!cfg.workerUrl || !cfg.captureToken) {
    throw new Error("config.json missing workerUrl or captureToken");
  }
  return cfg;
}

async function checkForRefreshRequest(cfg) {
  const url = cfg.workerUrl.replace(/\/capture$/, "/native-host/check-refresh");
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Capture-Token": cfg.captureToken },
    });
    if (!res.ok) {
      log("warn", "check-refresh non-OK", { status: res.status });
      return null;
    }
    const data = await res.json();
    if (data.pending) return data;
    return null;
  } catch (e) {
    log("warn", "check-refresh fetch failed", { error: e.message });
    return null;
  }
}

async function reportComplete(cfg, ok, message) {
  const url = cfg.workerUrl.replace(/\/capture$/, "/native-host/refresh-complete");
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Capture-Token": cfg.captureToken,
      },
      body: JSON.stringify({ ok, message }),
    });
  } catch (e) {
    log("warn", "report-complete failed", { error: e.message });
  }
}

function runSetup() {
  return new Promise((resolve) => {
    const indexPath = path.join(__dirname, "index.js");
    log("info", "spawning index.js --setup");
    const child = spawn(process.execPath, [indexPath, "--setup"], {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      log("info", "index.js --setup exited", { code });
      resolve(code === 0);
    });
    child.on("error", (err) => {
      log("error", "spawn error", { error: err.message });
      resolve(false);
    });
  });
}

async function tick(cfg) {
  const req = await checkForRefreshRequest(cfg);
  if (!req) return;
  log("info", "refresh requested", { by: req.requestedBy, at: req.requestedAt });
  const ok = await runSetup();
  await reportComplete(cfg, ok, ok ? "Setup completed OK" : "Setup failed (check last-error.png)");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = readConfig();
  log("info", "watcher started", { workerUrl: cfg.workerUrl, pollMs: POLL_INTERVAL_MS });

  if (args.has("--once")) {
    await tick(cfg);
    process.exit(0);
  }

  // Run forever
  while (true) {
    try {
      await tick(cfg);
    } catch (e) {
      log("error", "tick failed", { error: e.message });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  log("error", "fatal", { error: err.message });
  process.exit(2);
});
