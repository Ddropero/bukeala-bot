/**
 * Bukeala Native Host — Refresh Watcher (macOS)
 *
 * Polea el Worker cada 30s para `/sesion_renew` requests. Cuando detecta
 * uno, spawnea `node index.js --auto-login` (si tiene 2Captcha) o `--setup`
 * (login manual visible).
 *
 * Diferencias vs Windows:
 *   - APP_DIR: ~/Library/Application Support/BukealaBot
 *   - Corre vía launchd (KeepAlive=true, RunAtLoad=true)
 *   - Logs van a archivos definidos en el .plist
 *
 * Run:
 *   node watcher.js --auto-login-mode
 *   node watcher.js --worker URL --token TOKEN --2captcha-key KEY --auto-login-mode
 *   node watcher.js --once  (single check, useful for testing)
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const APP_DIR = path.join(os.homedir(), "Library", "Application Support", "BukealaBot");
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const LOG_PATH = path.join(APP_DIR, "watcher.log");
const POLL_INTERVAL_MS = 30 * 1000;

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
  } catch {/* ignore */}
}

function readConfig() {
  // Priority: CLI args > env vars > config.json
  const argv = process.argv.slice(2);
  const argMap = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      argMap.set(argv[i].slice(2), argv[i + 1]);
      i++;
    }
  }

  if (argMap.has("worker") && argMap.has("token")) {
    return { workerUrl: argMap.get("worker"), captureToken: argMap.get("token") };
  }

  if (process.env.BUKEALA_WORKER_URL && process.env.BUKEALA_CAPTURE_TOKEN) {
    return {
      workerUrl: process.env.BUKEALA_WORKER_URL,
      captureToken: process.env.BUKEALA_CAPTURE_TOKEN,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    log("error", "config.json read failed", { configPath: CONFIG_PATH, readError: err.message });
    throw new Error(`config no encontrado. Pasa --worker URL --token TOKEN. ${err.message}`);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const cfg = JSON.parse(raw);
  if (!cfg.workerUrl || !cfg.captureToken) {
    throw new Error("config.json sin workerUrl o captureToken");
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

function autoLoginEnabled() {
  const argv = process.argv.slice(2);
  if (argv.includes("--auto-login-mode")) return true;
  if (process.env.BUKEALA_AUTO_LOGIN === "1") return true;
  return false;
}

function runSetup() {
  return new Promise((resolve) => {
    const indexPath = path.join(__dirname, "index.js");
    const mode = autoLoginEnabled() ? "--auto-login" : "--setup";
    log("info", `spawning index.js ${mode}`);

    const argv = process.argv.slice(2);
    const argMap = new Map();
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith("--") && i + 1 < argv.length) {
        argMap.set(argv[i].slice(2), argv[i + 1]);
        i++;
      }
    }
    const childEnv = { ...process.env };
    if (argMap.has("worker")) childEnv.BUKEALA_WORKER_URL = argMap.get("worker");
    if (argMap.has("token")) childEnv.BUKEALA_CAPTURE_TOKEN = argMap.get("token");
    if (argMap.has("2captcha-key")) childEnv.TWO_CAPTCHA_API_KEY = argMap.get("2captcha-key");

    // creds.dat content via env var (más confiable que filesystem visibility)
    const credsCandidates = [
      path.join(__dirname, "creds.dat"),
      path.join(APP_DIR, "creds.dat"),
    ];
    for (const credsPath of credsCandidates) {
      try {
        const credsContent = fs.readFileSync(credsPath, "utf8");
        childEnv.BUKEALA_CREDS_RAW = credsContent;
        log("info", "creds.dat passed via env", { from: credsPath, bytes: credsContent.length });
        break;
      } catch {/* try next */}
    }

    const child = spawn(process.execPath, [indexPath, mode], {
      cwd: __dirname,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
    child.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    child.on("exit", (code) => {
      log("info", `index.js ${mode} exited`, {
        code,
        stdoutTail: stdoutBuf.slice(-800),
        stderrTail: stderrBuf.slice(-800),
      });
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
  await reportComplete(cfg, ok, ok ? "Setup completed OK" : "Setup failed");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = readConfig();
  log("info", "watcher started", { workerUrl: cfg.workerUrl, pollMs: POLL_INTERVAL_MS, autoLogin: autoLoginEnabled() });

  if (args.has("--once")) {
    await tick(cfg);
    process.exit(0);
  }

  while (true) {
    try { await tick(cfg); } catch (e) { log("error", "tick failed", { error: e.message }); }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  log("error", "fatal", { error: err.message });
  process.exit(2);
});
