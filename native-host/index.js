/**
 * Bukeala Native Host (v3 — storageState mode)
 *
 * The CAS login page has reCAPTCHA, so we can't fully automate it. CAS also
 * tags the TGC as a session-only cookie that dies when the browser closes,
 * so launchPersistentContext alone is not enough.
 *
 * Solution: use Playwright's `storageState` API. After manual login (visible
 * Chromium window), we explicitly snapshot all cookies + localStorage to a
 * JSON file. Subsequent headless runs load that snapshot, which DOES preserve
 * session cookies because Playwright restores them as if the browser had
 * never closed.
 *
 * Modes:
 *   node index.js --setup    open visible browser → user logs in → save state.json
 *   node index.js            headless: load state.json → push cookies to Worker
 *   node index.js --watch    same as default but loops every 4h
 *
 * If the recurring run detects the login form (TGC dead on the server side,
 * CAS forgot the session), it logs a warning and exits non-zero so the user
 * knows to re-run --setup.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
chromium.use(StealthPlugin());

const APP_DIR = path.join(process.env.APPDATA || os.homedir(), "BukealaBot");
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const LOG_PATH = path.join(APP_DIR, "last-run.log");
const STATE_PATH = path.join(APP_DIR, "state.json");

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

// ====================================================================
// Logging
// ====================================================================
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
  } catch {
    // ignore log write failure
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config not found. Run install.ps1 first. Expected at: ${CONFIG_PATH}`,
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.workerUrl || !cfg.captureToken) {
    throw new Error("config.json must have workerUrl and captureToken");
  }
  return cfg;
}

function isOnLoginPage(url) {
  return (
    url.includes("/cas/login") ||
    url.includes("/authentication/login")
  );
}

const CONTEXT_OPTIONS = {
  viewport: { width: 1366, height: 800 },
  locale: "es-CO",
  timezoneId: "America/Bogota",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "es-CO,es;q=0.9,en;q=0.8" },
};

// ====================================================================
// Setup mode — visible browser, manual login, save state.json
// ====================================================================
async function setupMode() {
  log("info", "setup mode — opening visible Chromium for manual login");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();

  await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded" });

  console.log("");
  console.log("============================================");
  console.log("  LOGIN MANUAL EN LA VENTANA ABIERTA");
  console.log("");
  console.log("  1. Loguea con tu usuario CAS Colsanitas");
  console.log("     (resuelve el reCAPTCHA tu mismo)");
  console.log("  2. Espera a ver la pagina principal de");
  console.log("     Bukeala (\"Buscar disponibilidad\")");
  console.log("  3. La ventana se cierra sola cuando");
  console.log("     detecte que estas adentro.");
  console.log("============================================");
  console.log("");

  // Poll URL: when we leave the CAS login page and arrive at the SP, we're
  // logged in. Save state and close automatically. Timeout: 5 min.
  const startedAt = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000;
  let savedOk = false;

  while (Date.now() - startedAt < TIMEOUT_MS) {
    let url = "";
    try {
      url = page.url();
    } catch {
      break;
    }

    if (
      url.includes("appoint.tuscitasmedicas.com") &&
      !isOnLoginPage(url)
    ) {
      // Wait a bit so JSESSIONID Set-Cookie completes
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

  // Show summary on console before closing
  if (savedOk) {
    console.log("");
    console.log("[OK] Login detectado y state.json guardado.");
    console.log("Cerrando ventana en 3 segundos...");
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    console.log("");
    console.log("[!] Timeout o cierre manual — state.json NO se guardo.");
    console.log("    Vuelve a correr 'node index.js --setup' y completa el login.");
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  if (!savedOk) process.exit(1);

  // Print quick stats so user can verify the right cookies are saved
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const auth = (state.cookies || []).filter((c) =>
      ["JSESSIONID", "CASTGC", "TGC", "iPlanetDirectoryPro"].includes(c.name),
    );
    console.log(
      `[OK] Cookies en state.json: ${state.cookies.length} total, ${auth.length} de autenticacion`,
    );
    if (auth.length === 0) {
      console.log(
        "[!] OJO: ninguna cookie de autenticacion se guardo. ¿Llegaste a la pagina de Buscar disponibilidad?",
      );
    } else {
      auth.forEach((c) =>
        console.log(`     - ${c.name} @ ${c.domain} (expires=${c.expires})`),
      );
    }
  } catch {
    // ignore
  }
}

// ====================================================================
// Recurring mode — headless, restore state, push cookies to Worker
// ====================================================================
async function reportEvent(cfg, event) {
  // Fire-and-forget event report to the Worker
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
    throw new Error(
      `state.json not found at ${STATE_PATH}. Run 'node index.js --setup' first.`,
    );
  }
  const cfg = readConfig();
  const startedAt = Date.now();
  log("info", "recurring run — using state.json", { worker: cfg.workerUrl });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    storageState: STATE_PATH,
  });
  const page = await context.newPage();
  let result = { ok: false };

  try {
    log("info", "navigating to Bukeala home");
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Allow CAS service-ticket flow to settle
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    log("info", "ended at", { url: finalUrl });

    if (isOnLoginPage(finalUrl)) {
      log("warn", "TGC expired on CAS server — manual --setup required");
      result = { ok: false, reason: "needs_manual_login" };
      try {
        const shotPath = path.join(APP_DIR, "last-error.png");
        await page.screenshot({ path: shotPath, fullPage: true });
      } catch {
        // ignore
      }
      await reportEvent(cfg, {
        type: "tgc_expired",
        message: "TGC expired on CAS server",
        durationMs: Date.now() - startedAt,
      });
      return result;
    }

    // Save back the (possibly refreshed) state so next run benefits from
    // any rotated JSESSIONID/AWSALB.
    try {
      await context.storageState({ path: STATE_PATH });
    } catch {
      // ignore
    }

    // Extract cookies and push to worker
    const cookies = await context.cookies();
    const filtered = cookies.filter((c) => {
      const d = (c.domain || "").toLowerCase();
      return d.includes("tuscitasmedicas.com") || d.includes("colsanitas.com");
    });
    if (filtered.length === 0) throw new Error("No relevant cookies captured");
    log("info", "captured cookies", { count: filtered.length });

    const payload = {
      capturedAt: new Date().toISOString(),
      cookies: filtered.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires === -1 ? undefined : c.expires,
        httpOnly: c.httpOnly,
      })),
    };

    const res = await fetch(cfg.workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Capture-Token": cfg.captureToken,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Worker rejected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
    log("info", "session pushed to worker", { status: res.status, body });
    result = { ok: true, count: filtered.length, status: res.status };
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
    try {
      const shotPath = path.join(APP_DIR, "last-error.png");
      await page.screenshot({ path: shotPath, fullPage: true });
      log("info", "saved error screenshot", { path: shotPath });
    } catch {
      // ignore
    }
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

  if (args.has("--watch")) {
    log("info", "watch mode: refreshing every 4 hours");
    while (true) {
      try {
        await recurringRun();
      } catch (e) {
        log("error", "iteration failed", { error: e.message });
      }
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
