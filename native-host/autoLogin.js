/**
 * Auto-login flow for Bukeala/CAS Colsanitas with 2Captcha integration.
 *
 * Flow:
 *   1. Read encrypted credentials (DPAPI)
 *   2. Launch headless Chromium (with stealth)
 *   3. Navigate to Bukeala → redirected to CAS login
 *   4. Fill username + password
 *   5. Detect reCAPTCHA sitekey, send to 2Captcha API
 *   6. Wait for solution token (~10-20 sec)
 *   7. Inject token into g-recaptcha-response → submit
 *   8. Wait for redirect back to Bukeala
 *   9. Capture state.json + cookies → push to Worker
 *
 * Total time: ~30-40 sec, fully automated.
 *
 * Cost per login: ~$0.001 USD via 2Captcha.
 *
 * Failure modes (each escalates to manual --setup):
 *   - 2Captcha timeout / no balance → user must do manual login
 *   - reCAPTCHA v3 invisible (no challenge) → solver returns nothing → fallback
 *   - CAS changed login form selectors → fail with screenshot
 *   - Credentials wrong → CAS shows "invalid" → save screenshot, escalate
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Apply stealth once (idempotent if also called from index.js)
try {
  chromium.use(StealthPlugin());
} catch {
  // already applied
}

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const TWO_CAPTCHA_POLL_INTERVAL_MS = 5000;
const TWO_CAPTCHA_MAX_WAIT_MS = 120 * 1000; // 2 min hard cap

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

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
// Credentials (DPAPI per-user, encrypted)
// ====================================================================

/**
 * Reads the credentials file (USER|DPAPI_ENCRYPTED_PASS) and returns
 * { username, password } in plaintext (only this Windows user can decrypt).
 */
function readCredentials(credsPath) {
  if (!fs.existsSync(credsPath)) {
    throw new Error(
      `Credentials not configured. Run: node index.js --save-credentials`,
    );
  }
  const enc = fs.readFileSync(credsPath, "utf8").trim();
  if (!enc) throw new Error("creds.dat is empty");

  const sep = enc.indexOf("|");
  if (sep < 1) throw new Error("creds.dat format invalid");
  const username = enc.slice(0, sep);
  const encryptedPassword = enc.slice(sep + 1);

  // Decrypt via PowerShell + DPAPI
  const psCmd =
    "$ss = ConvertTo-SecureString -String $env:ENC; " +
    "$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); " +
    "$pw = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr); " +
    "[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); " +
    "Write-Output $pw";
  const password = execSync(
    `powershell -NoProfile -NonInteractive -Command "${psCmd}"`,
    {
      env: { ...process.env, ENC: encryptedPassword },
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();

  if (!password) throw new Error("Failed to decrypt password (DPAPI)");
  return { username, password };
}

// ====================================================================
// 2Captcha integration
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

  // Poll until solved or timeout
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
// Main flow
// ====================================================================

/**
 * @param env { TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL, APP_DIR, log }
 * @returns { ok, reason?, cookieCount? }
 */
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

    // Wait for either CAS login form or already-logged-in Bukeala
    await page.waitForTimeout(2000);
    const url = page.url();
    log("info", "after navigation", { url });

    if (url.includes("appoint.tuscitasmedicas.com") && !url.includes("/cas/login")) {
      log("info", "session already alive, skipping login");
    } else {
      // We're at CAS login. Fill credentials.
      log("info", "at CAS login, filling credentials");
      const userSel = 'input[name="username"], input#username';
      const passSel = 'input[name="password"], input#password';
      const submitSel = 'button[type="submit"], input[type="submit"], button[name="submit"]';

      await page.waitForSelector(userSel, { timeout: 30_000 });
      await page.fill(userSel, creds.username);
      await page.fill(passSel, creds.password);

      // Detect reCAPTCHA sitekey
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
        // Inject token into g-recaptcha-response (hidden textarea)
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
          // Some sites have a callback registered with the widget
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

      // Submit form
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
        page.click(submitSel),
      ]);
      await page.waitForTimeout(2500); // CAS redirect chain

      const finalUrl = page.url();
      log("info", "after submit", { url: finalUrl });

      // Sanity check: we should be at Bukeala
      if (finalUrl.includes("/cas/login") && !finalUrl.includes("ticket=")) {
        // Still on login → credentials wrong, or reCAPTCHA failed
        const errorText = await page
          .locator(".alert-danger, .errors, .login-error")
          .first()
          .textContent()
          .catch(() => null);
        throw new Error(`Login failed (still at CAS): ${errorText ?? "unknown"}`);
      }
    }

    // Save state.json
    await context.storageState({ path: statePath });
    log("info", "state.json saved", { path: statePath });

    // Push cookies to worker
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
    } catch {
      // ignore
    }
    result = { ok: false, reason: e.message };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

// ====================================================================
// Save-credentials interactive prompt
// ====================================================================

/**
 * Prompts via PowerShell (Read-Host -AsSecureString → DPAPI encrypted).
 * Saves to creds.dat in APP_DIR.
 */
function saveCredentials(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  const credsPath = path.join(appDir, "creds.dat");

  const psScript = `
$ErrorActionPreference = 'Stop'
Write-Host ''
Write-Host '=== Guardar credenciales CAS Colsanitas ===' -ForegroundColor Cyan
Write-Host 'Las credenciales se guardan ENCRIPTADAS con DPAPI per-user.' -ForegroundColor Yellow
Write-Host 'Solo este usuario de Windows puede desencriptarlas.' -ForegroundColor Yellow
Write-Host ''

$username = Read-Host 'Usuario CAS (cedula o login)'
if (-not $username) { Write-Host '[X] Usuario vacio' -ForegroundColor Red; exit 1 }

$securePass = Read-Host 'Password' -AsSecureString
$encrypted = $securePass | ConvertFrom-SecureString

"$username|$encrypted" | Set-Content -Path '${credsPath.replace(/\\/g, "\\\\")}' -Encoding UTF8 -NoNewline

Write-Host ''
Write-Host '[OK] Credenciales guardadas en ${credsPath.replace(/\\/g, "\\\\")}' -ForegroundColor Green
`;

  // Run interactive — inheritStdio so user sees prompts
  const { spawnSync } = require("node:child_process");
  const res = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
    stdio: "inherit",
  });
  return res.status === 0;
}

module.exports = { runAutoLogin, saveCredentials, readCredentials };
