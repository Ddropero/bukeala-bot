/**
 * Auto-login flow para macOS (versión cross-platform sin DPAPI).
 *
 * Cifrado de credenciales:
 *   - AES-256-GCM con clave maestra única por instalación
 *   - Clave maestra guardada en ~/.bukeala-key (mode 0600 — solo el usuario)
 *   - Formato creds.dat: "v2:<base64 iv>:<base64 ciphertext>:<base64 authTag>:<username plaintext>"
 *
 * Flow:
 *   1. Lee credenciales cifradas
 *   2. Lanza Chromium headless con stealth
 *   3. Navega a Bukeala → CAS redirect
 *   4. Llena usuario + password
 *   5. Detecta reCAPTCHA sitekey → 2Captcha API
 *   6. Espera token (~10-20s) → lo inyecta
 *   7. Submit → espera redirect a Bukeala (no /admin)
 *   8. Si terminó en /admin, fuerza navegación a /keraltyadscritos
 *   9. Captura state.json + cookies → push al Worker
 *
 * Tiempo total: ~30-40s, totalmente automatizado.
 * Costo por login: ~$0.003 USD vía 2Captcha.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

try {
  chromium.use(StealthPlugin());
} catch {
  // already applied
}

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const TWO_CAPTCHA_POLL_INTERVAL_MS = 5000;
const TWO_CAPTCHA_MAX_WAIT_MS = 120 * 1000;

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

const MASTER_KEY_PATH = path.join(os.homedir(), ".bukeala-key");

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
// Master key management
// ====================================================================

function readMasterKey() {
  if (!fs.existsSync(MASTER_KEY_PATH)) {
    throw new Error(
      `Master key no encontrada en ${MASTER_KEY_PATH}. Corre el instalador o 'node index.js --save-credentials'.`,
    );
  }
  const hex = fs.readFileSync(MASTER_KEY_PATH, "utf8").trim();
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(`Master key inválida: ${key.length} bytes (esperaba 32)`);
  }
  return key;
}

function generateMasterKey() {
  const key = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_PATH, key.toString("hex"), { mode: 0o600 });
  // chmod explícito por si fs.writeFileSync no lo respeta en todos los FS
  try {
    fs.chmodSync(MASTER_KEY_PATH, 0o600);
  } catch {/* ignore */}
  return key;
}

// ====================================================================
// Credentials cifradas con AES-256-GCM
// ====================================================================

/**
 * Lee creds.dat (formato v2: "v2:iv:cipher:tag:username") y devuelve
 * { username, password } en plano.
 */
function readCredentials(credsPath) {
  let enc;
  if (process.env.BUKEALA_CREDS_RAW) {
    enc = process.env.BUKEALA_CREDS_RAW.trim();
  } else if (fs.existsSync(credsPath)) {
    enc = fs.readFileSync(credsPath, "utf8").trim();
  } else {
    throw new Error(
      `Credentials no configuradas. Corre: node index.js --save-credentials`,
    );
  }
  if (!enc) throw new Error("creds.dat vacío");

  // Strip BOM
  if (enc.charCodeAt(0) === 0xfeff) enc = enc.slice(1);

  if (!enc.startsWith("v2:")) {
    throw new Error(
      "creds.dat formato no reconocido (esperaba v2:). En Mac usamos v2; el v1 (DPAPI) solo funciona en Windows.",
    );
  }

  const parts = enc.slice(3).split(":");
  if (parts.length < 4) throw new Error("creds.dat formato v2 inválido");
  const [ivB64, cipherB64, tagB64, ...userParts] = parts;
  const username = userParts.join(":"); // por si el usuario tiene ":" raro

  const masterKey = readMasterKey();
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(cipherB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(authTag);
  const password = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  if (!password) throw new Error("password vacío post-descifrado");
  return { username, password };
}

/**
 * Cifra y guarda credenciales. Genera master key si no existe.
 */
function writeCredentials(credsPath, username, password) {
  let masterKey;
  if (fs.existsSync(MASTER_KEY_PATH)) {
    masterKey = readMasterKey();
  } else {
    masterKey = generateMasterKey();
    console.log(`[OK] Master key generada en ${MASTER_KEY_PATH} (mode 0600)`);
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const enc = [
    "v2",
    iv.toString("base64"),
    ciphertext.toString("base64"),
    authTag.toString("base64"),
    username,
  ].join(":");

  fs.mkdirSync(path.dirname(credsPath), { recursive: true });
  fs.writeFileSync(credsPath, enc, { mode: 0o600 });
  try {
    fs.chmodSync(credsPath, 0o600);
  } catch {/* ignore */}
}

// ====================================================================
// 2Captcha integration (igual que Windows)
// ====================================================================

async function solveRecaptcha(twoCaptchaKey, sitekey, pageUrl, log) {
  log("info", "submitting reCAPTCHA to 2Captcha", { sitekey, pageUrl });
  const submitParams = new URLSearchParams({
    key: twoCaptchaKey,
    method: "userrecaptcha",
    googlekey: sitekey,
    pageurl: pageUrl,
    json: "1",
  });
  const subRes = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${submitParams}`);
  const subJson = await subRes.json();
  if (subJson.status !== 1) {
    throw new Error(`2Captcha submit failed: ${subJson.request ?? "unknown"}`);
  }
  const captchaId = subJson.request;
  log("info", "2Captcha task created", { captchaId });

  const startedAt = Date.now();
  while (Date.now() - startedAt < TWO_CAPTCHA_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, TWO_CAPTCHA_POLL_INTERVAL_MS));
    const pollRes = await fetch(
      `${TWO_CAPTCHA_BASE}/res.php?key=${twoCaptchaKey}&action=get&id=${captchaId}&json=1`,
    );
    const pollJson = await pollRes.json();
    if (pollJson.status === 1) {
      log("info", "2Captcha solved", { elapsedMs: Date.now() - startedAt });
      return pollJson.request;
    }
    if (pollJson.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha poll failed: ${pollJson.request}`);
    }
  }
  throw new Error("2Captcha timeout (>2 min)");
}

// ====================================================================
// Main flow (igual estructura que Windows)
// ====================================================================

async function runAutoLogin(env) {
  const { TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL, APP_DIR, log } = env;

  if (!TWO_CAPTCHA_API_KEY) {
    return { ok: false, reason: "TWO_CAPTCHA_API_KEY missing in config" };
  }

  const credsPath = path.join(APP_DIR, "creds.dat");
  const statePath = path.join(APP_DIR, "state.json");

  let creds;
  try {
    creds = readCredentials(credsPath);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  log("info", "credentials decrypted", { user: creds.username });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();

  let result = { ok: false };

  try {
    log("info", "navigating to Bukeala");
    await page.goto(BUKEALA_HOME, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(2000);
    const url = page.url();
    log("info", "after navigation", { url });

    if (url.includes("appoint.tuscitasmedicas.com") && !url.includes("/cas/login")) {
      log("info", "session already alive, skipping login");
    } else {
      log("info", "at CAS login, filling credentials");
      const userSel = 'input[name="username"], input#username';
      const passSel = 'input[name="password"], input#password';
      const submitSel = 'button[type="submit"], input[type="submit"], button[name="submit"]';

      await page.waitForSelector(userSel, { timeout: 30_000 });
      await page.fill(userSel, creds.username);
      await page.fill(passSel, creds.password);

      const sitekey = await page
        .$eval(
          ".g-recaptcha, [data-sitekey]",
          (el) => el.getAttribute("data-sitekey"),
        )
        .catch(() => null);

      if (sitekey) {
        log("info", "reCAPTCHA detected", { sitekey });
        const token = await solveRecaptcha(
          TWO_CAPTCHA_API_KEY,
          sitekey,
          page.url(),
          log,
        );
        await page.evaluate((t) => {
          let el = document.getElementById("g-recaptcha-response");
          if (!el) {
            el = document.createElement("textarea");
            el.id = "g-recaptcha-response";
            el.name = "g-recaptcha-response";
            el.style.display = "none";
            document.body.appendChild(el);
          }
          el.value = t;
          el.innerHTML = t;
          if (
            typeof window.___grecaptcha_cfg !== "undefined" &&
            window.___grecaptcha_cfg.clients
          ) {
            const clients = window.___grecaptcha_cfg.clients;
            for (const cid in clients) {
              for (const k in clients[cid]) {
                if (typeof clients[cid][k] === "object") {
                  for (const k2 in clients[cid][k]) {
                    if (
                      typeof clients[cid][k][k2] === "object" &&
                      clients[cid][k][k2] &&
                      typeof clients[cid][k][k2].callback === "function"
                    ) {
                      try {
                        clients[cid][k][k2].callback(t);
                      } catch {}
                    }
                  }
                }
              }
            }
          }
        }, token);
        log("info", "reCAPTCHA token injected");
      } else {
        log("info", "no reCAPTCHA detected, submitting directly");
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
        page.click(submitSel),
      ]);
      await page.waitForTimeout(2500);

      const finalUrl = page.url();
      log("info", "after submit", { url: finalUrl });

      if (finalUrl.includes("/cas/login") && !finalUrl.includes("ticket=")) {
        const errorText = await page
          .locator(".alert-danger, .errors, .login-error")
          .first()
          .textContent()
          .catch(() => null);
        throw new Error(`Login failed (still at CAS): ${errorText ?? "unknown"}`);
      }
    }

    // CRITICAL: forzar navegación a /keraltyadscritos para que ESA servlet
    // inicialice su JSESSIONID antes de capturar cookies (a veces el post-login
    // termina en /admin que tiene JSESSIONID separado y rompe el bot).
    if (!page.url().includes("/keraltyadscritos/")) {
      log("info", "post-login en otra app, navegando a /keraltyadscritos");
      try {
        await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(1500);
        log("info", "ahora en", { url: page.url() });
      } catch (e) {
        log("warn", "navegación falló (continuo igual)", { error: e.message });
      }
    }

    // Verificación: fetch interno a /findCustomer
    try {
      const verifyResp = await page.evaluate(async () => {
        const r = await fetch("/keraltyadscritos/findCustomer", {
          credentials: "include",
          redirect: "manual",
        });
        return { status: r.status, type: r.type, ok: r.ok };
      });
      log("info", "verificación /keraltyadscritos", verifyResp);
    } catch (e) {
      log("warn", "verificación falló (no bloqueante)", { error: e.message });
    }

    await context.storageState({ path: statePath });
    log("info", "state.json saved", { path: statePath });

    const cookies = await context.cookies();
    const filtered = cookies.filter((c) => {
      const d = (c.domain || "").toLowerCase();
      return d.includes("tuscitasmedicas.com") || d.includes("colsanitas.com");
    });
    if (filtered.length === 0) throw new Error("No relevant cookies captured");

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

    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Capture-Token": CAPTURE_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Worker rejected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    }

    log("info", "session pushed to worker", { status: res.status, cookieCount: filtered.length });
    result = { ok: true, cookieCount: filtered.length };
  } catch (e) {
    log("error", "auto-login failed", { error: e.message });
    try {
      await page.screenshot({ path: path.join(APP_DIR, "last-error.png"), fullPage: true });
    } catch {/* ignore */}
    result = { ok: false, reason: e.message };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

// ====================================================================
// Save-credentials interactive (Mac version — usa readline, no PowerShell)
// ====================================================================

function saveCredentials(appDir) {
  const readline = require("node:readline");
  const credsPath = path.join(appDir, "creds.dat");
  fs.mkdirSync(appDir, { recursive: true });

  console.log("");
  console.log("=== Guardar credenciales CAS Colsanitas ===");
  console.log("Las credenciales se cifran con AES-256-GCM.");
  console.log(`Master key (única por instalación) en: ${MASTER_KEY_PATH}`);
  console.log(`creds.dat (cifrado) en: ${credsPath}`);
  console.log("");

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Usuario CAS (ej. 80040718.prest): ", (username) => {
      if (!username) {
        console.log("[X] Usuario vacío.");
        rl.close();
        return resolve(false);
      }
      // Ocultar password al teclear
      process.stdout.write("Password: ");
      let password = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      const onData = (chunk) => {
        const c = chunk.toString();
        if (c === "\r" || c === "\n" || c === "") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          if (!password) {
            console.log("[X] Password vacío.");
            return resolve(false);
          }
          try {
            writeCredentials(credsPath, username.trim(), password);
            console.log("");
            console.log(`[OK] Credenciales guardadas (cifradas AES-256-GCM) en ${credsPath}`);
            resolve(true);
          } catch (e) {
            console.error("[X] Error cifrando:", e.message);
            resolve(false);
          }
          return;
        }
        if (c === "") {
          // Ctrl-C
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (c === "" || c === "\b") {
          // backspace
          password = password.slice(0, -1);
        } else {
          password += c;
        }
      };
      process.stdin.on("data", onData);
    });
  });
}

module.exports = { runAutoLogin, saveCredentials, readCredentials, writeCredentials };
