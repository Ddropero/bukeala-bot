/**
 * Bukeala Native Host — macOS edition
 *
 * Diferencias vs Windows:
 *   - APP_DIR: ~/Library/Application Support/BukealaBot (no %APPDATA%)
 *   - Credenciales: AES-256-GCM con master key local (no DPAPI)
 *   - Auto-start: launchd .plist (no Task Scheduler)
 *
 * Modos:
 *   node index.js --setup              ventana visible Chromium, login manual → state.json
 *   node index.js --save-credentials   cifra y guarda usuario/password CAS
 *   node index.js --auto-login         headless con 2Captcha (usado por watcher)
 *   node index.js --watch              loop infinito cada 4h
 *   node index.js                      one-shot recurring run (usa state.json existente)
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
chromium.use(StealthPlugin());

// macOS standard app data dir
const APP_DIR = path.join(os.homedir(), "Library", "Application Support", "BukealaBot");
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const LOG_PATH = path.join(APP_DIR, "last-run.log");
const STATE_PATH = path.join(APP_DIR, "state.json");

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  const line = JSON.stringify(entry);
  console.log(line);
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > 500_000) {
      const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
      fs.writeFileSync(LOG_PATH, lines.slice(-500).join("\n"), "utf8");
    }
  } catch { /* ignore */ }
}

function readConfig() {
  // Priority 1: env vars (watcher passes them this way)
  if (process.env.BUKEALA_WORKER_URL && process.env.BUKEALA_CAPTURE_TOKEN) {
    return {
      workerUrl: process.env.BUKEALA_WORKER_URL,
      captureToken: process.env.BUKEALA_CAPTURE_TOKEN,
      twoCaptchaApiKey: process.env.TWO_CAPTCHA_API_KEY || undefined,
    };
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config no encontrada. Corre install.sh primero. Esperado en: ${CONFIG_PATH}`,
    );
  }
  let raw = fs.readFileSync(CONFIG_PATH, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const cfg = JSON.parse(raw);
  if (!cfg.workerUrl || !cfg.captureToken) {
    throw new Error("config.json debe tener workerUrl y captureToken");
  }
  return cfg;
}

function isOnLoginPage(url) {
  return url.includes("/cas/login") || url.includes("/authentication/login");
}

const CONTEXT_OPTIONS = {
  viewport: { width: 1366, height: 800 },
  locale: "es-CO",
  timezoneId: "America/Bogota",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "es-CO,es;q=0.9,en;q=0.8" },
};

// ====================================================================
// Setup mode — visible browser, manual login
// ====================================================================
async function setupMode() {
  log("info", "setup mode — opening visible Chromium");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();

  await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded" });

  console.log("\n=============================================");
  console.log("  LOGIN MANUAL EN LA VENTANA ABIERTA");
  console.log("");
  console.log("  1. Loguea con tu usuario CAS Colsanitas");
  console.log("     (resuelve el reCAPTCHA tu mismo)");
  console.log("  2. Espera a ver la página principal");
  console.log("     de Bukeala (\"Buscar disponibilidad\")");
  console.log("  3. La ventana se cierra sola.");
  console.log("=============================================\n");

  const startedAt = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000;
  let savedOk = false;

  while (Date.now() - startedAt < TIMEOUT_MS) {
    let url = "";
    try { url = page.url(); } catch { break; }
    if (url.includes("appoint.tuscitasmedicas.com") && !isOnLoginPage(url)) {
      await new Promise((r) => setTimeout(r, 3500));
      try {
        await context.storageState({ path: STATE_PATH });
        savedOk = true;
        log("info", "state.json saved", { path: STATE_PATH });
      } catch (e) {
        log("error", "storageState save failed", { error: e.message });
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (savedOk) {
    console.log("\n[OK] Login detectado y state.json guardado.");
    console.log("Cerrando ventana en 3 segundos...");
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    console.log("\n[!] Timeout — state.json NO se guardó.");
    console.log("    Vuelve a correr 'node index.js --setup'.");
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  if (!savedOk) process.exit(1);
}

// ====================================================================
// Recurring run — push cookies to Worker
// ====================================================================
async function reportEvent(cfg, event) {
  if (!cfg) return;
  try {
    const url = cfg.workerUrl.replace(/\/capture$/, "/native-host/event");
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Capture-Token": cfg.captureToken,
      },
      body: JSON.stringify({ at: new Date().toISOString(), ...event }),
    });
  } catch (e) {
    log("warn", "event report failed", { error: e.message });
  }
}

async function recurringRun() {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`state.json no encontrado en ${STATE_PATH}. Corre 'node index.js --setup' primero.`);
  }
  const cfg = readConfig();
  const startedAt = Date.now();
  log("info", "recurring run", { worker: cfg.workerUrl });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    storageState: STATE_PATH,
  });
  const page = await context.newPage();
  let result = { ok: false };

  try {
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    log("info", "ended at", { url: finalUrl });

    if (isOnLoginPage(finalUrl)) {
      log("warn", "TGC expired — manual --setup required");
      result = { ok: false, reason: "needs_manual_login" };
      await reportEvent(cfg, {
        type: "tgc_expired",
        message: "TGC expired on CAS server",
        durationMs: Date.now() - startedAt,
      });
      return result;
    }

    try { await context.storageState({ path: STATE_PATH }); } catch {/* ignore */}

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

    const res = await fetch(cfg.workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": cfg.captureToken },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Worker rejected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);

    log("info", "session pushed", { status: res.status, cookieCount: filtered.length });
    result = { ok: true, count: filtered.length };
    await reportEvent(cfg, {
      type: "ok",
      message: `${filtered.length} cookies pushed`,
      cookieCount: filtered.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    log("error", "run failed", { error: err.message });
    result = { ok: false, error: err.message };
    await reportEvent(cfg, {
      type: "error",
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return result;
}

// ====================================================================
// Main
// ====================================================================
async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has("--setup")) {
    await setupMode();
    process.exit(0);
  }

  if (args.has("--save-credentials")) {
    const { saveCredentials } = require("./autoLogin");
    const ok = await saveCredentials(APP_DIR);
    process.exit(ok ? 0 : 1);
  }

  if (args.has("--auto-login")) {
    log("info", "auto-login mode start");
    let runAutoLogin;
    try {
      ({ runAutoLogin } = require("./autoLogin"));
      log("info", "autoLogin module loaded OK");
    } catch (e) {
      log("error", "failed to require autoLogin", { error: e.message });
      process.exit(2);
    }
    let cfg;
    try {
      cfg = readConfig();
    } catch (e) {
      log("error", "failed to read config", { error: e.message });
      process.exit(2);
    }
    if (!cfg.twoCaptchaApiKey) {
      log("error", "twoCaptchaApiKey missing in config.json");
      process.exit(2);
    }
    const r = await runAutoLogin({
      TWO_CAPTCHA_API_KEY: cfg.twoCaptchaApiKey,
      CAPTURE_TOKEN: cfg.captureToken,
      WORKER_URL: cfg.workerUrl,
      APP_DIR,
      log,
    });
    process.exit(r.ok ? 0 : 1);
  }

  if (args.has("--watch")) {
    log("info", "watch mode: cada 4 horas");
    while (true) {
      try { await recurringRun(); } catch (e) { log("error", "iter failed", { error: e.message }); }
      await new Promise((r) => setTimeout(r, 4 * 60 * 60 * 1000));
    }
  }

  const r = await recurringRun();
  process.exit(r.ok ? 0 : 1);
}

main().catch((err) => {
  log("error", "fatal", { error: err.message, stack: err.stack });
  process.exit(2);
});
