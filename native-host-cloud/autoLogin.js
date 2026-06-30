/**
 * Auto-login flow para la NUBE (Google Cloud VM).
 *
 * Credenciales por env vars (no se cifran en disco; la plataforma ya las
 * protege en reposo).
 *
 * Env requeridas:
 *   CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL
 * Opcional: STATE_FILE (default /tmp/bukeala-state.json)
 *
 * ESTRATEGIA (robusta, descubierta a las malas):
 *   - El objetivo es capturar un JSESSIONID de BUKEALA (appoint.tuscitasmedicas.com
 *     /keraltyadscritos). Un JSESSIONID del CAS (app01.colsanitas.com/cas) NO sirve
 *     — el Worker lo manda al login.
 *   - Restauramos SOLO las cookies del CAS/Colsanitas (incluye el TGC). NO
 *     restauramos las cookies viejas de Bukeala: así la navegación FUERZA a
 *     Bukeala a emitir un JSESSIONID fresco vía el ticket de CAS (con TGC válido,
 *     sin captcha).
 *   - Navegamos a BUKEALA_HOME y dejamos que Bukeala maneje el redirect a CAS con
 *     SU service registrado (no inventamos la URL del service).
 *   - VERIFICAMOS que haya un JSESSIONID de Bukeala. Si no lo hay (TGC expiró o el
 *     SSO no estableció sesión), hacemos un LOGIN COMPLETO LIMPIO (borramos
 *     cookies + formulario + reCAPTCHA). Eso SIEMPRE produce el JSESSIONID de
 *     Bukeala (es lo que funcionaba históricamente). En el peor caso = 1 captcha.
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

try { chromium.use(StealthPlugin()); } catch { /* already applied */ }

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const TWO_CAPTCHA_POLL_INTERVAL_MS = 5000;
const TWO_CAPTCHA_MAX_WAIT_MS = 120 * 1000;

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

const CONTEXT_OPTIONS = {
  viewport: { width: 1366, height: 800 },
  locale: "es-CO",
  timezoneId: "America/Bogota",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "es-CO,es;q=0.9,en;q=0.8" },
};

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

/** ¿El contexto tiene un JSESSIONID de Bukeala (no del CAS)? */
async function hasBukealaSession(context) {
  const cks = await context.cookies();
  return cks.some(
    (c) => c.name === "JSESSIONID" && (c.domain || "").toLowerCase().includes("tuscitasmedicas"),
  );
}

/**
 * Llena el formulario de CAS (usuario+clave+reCAPTCHA) y envía.
 * Asume que la página ya está en /cas/login. Devuelve true si usó captcha.
 */
async function submitCasForm(page, creds, TWO_CAPTCHA_API_KEY, log) {
  log("info", "at CAS login, filling credentials");
  const userSel = 'input[name="username"], input#username';
  const passSel = 'input[name="password"], input#password';
  const submitSel = 'button[type="submit"], input[type="submit"], button[name="submit"]';

  await page.waitForSelector(userSel, { timeout: 30_000 });
  await page.fill(userSel, creds.username);
  await page.fill(passSel, creds.password);

  let usedCaptcha = false;
  const sitekey = await page
    .$eval(".g-recaptcha, [data-sitekey]", (el) => el.getAttribute("data-sitekey"))
    .catch(() => null);

  if (sitekey) {
    log("info", "reCAPTCHA detected", { sitekey });
    const token = await solveRecaptcha(TWO_CAPTCHA_API_KEY, sitekey, page.url(), log);
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
      if (typeof window.___grecaptcha_cfg !== "undefined" && window.___grecaptcha_cfg.clients) {
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
                  try { clients[cid][k][k2].callback(t); } catch {}
                }
              }
            }
          }
        }
      }
    }, token);
    log("info", "reCAPTCHA token injected");
    usedCaptcha = true;
  } else {
    log("info", "no reCAPTCHA detected, submitting directly");
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
    page.click(submitSel),
  ]);
  await page.waitForTimeout(2500);
  return usedCaptcha;
}

/**
 * @param {object} env  { CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY,
 *                        CAPTURE_TOKEN, WORKER_URL, APP_DIR, STATE_FILE, log }
 */
async function runAutoLogin(env) {
  const {
    CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY,
    CAPTURE_TOKEN, WORKER_URL, APP_DIR, log,
  } = env;

  if (!CAS_USERNAME || !CAS_PASSWORD) return { ok: false, reason: "CAS_USERNAME/CAS_PASSWORD missing" };
  if (!TWO_CAPTCHA_API_KEY) return { ok: false, reason: "TWO_CAPTCHA_API_KEY missing" };
  if (!CAPTURE_TOKEN || !WORKER_URL) return { ok: false, reason: "CAPTURE_TOKEN/WORKER_URL missing" };

  const creds = { username: CAS_USERNAME, password: CAS_PASSWORD };
  const STATE_FILE = env.STATE_FILE || path.join(os.tmpdir(), "bukeala-state.json");
  log("info", "credentials from env", { user: creds.username });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  // Restaurar SOLO cookies del CAS/Colsanitas (TGC). NO las de Bukeala: así
  // forzamos un JSESSIONID fresco de Bukeala vía el ticket de CAS.
  const ctxOptions = { ...CONTEXT_OPTIONS };
  let restoredTgc = false;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const casCookies = (raw.cookies || []).filter((c) =>
        (c.domain || "").toLowerCase().includes("colsanitas.com"));
      if (casCookies.length) {
        ctxOptions.storageState = { cookies: casCookies, origins: [] };
        restoredTgc = true;
      }
    }
  } catch (e) { log("warn", "no se pudo leer STATE_FILE", { error: e.message }); }

  const context = await browser.newContext(ctxOptions);
  log("info", restoredTgc ? "TGC restaurado (solo CAS)" : "sin TGC previo (login completo)");
  const page = await context.newPage();

  let result = { ok: false };
  let usedCaptcha = false;

  try {
    // Intento 1: navegar a Bukeala. Si hay TGC válido, CAS auto-emite el ticket
    // y Bukeala crea JSESSIONID sin captcha. Si no, caemos al formulario.
    log("info", "navigating to Bukeala");
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);
    log("info", "after navigation", { url: page.url() });

    if (page.url().includes("/cas/login")) {
      usedCaptcha = await submitCasForm(page, creds, TWO_CAPTCHA_API_KEY, log) || usedCaptcha;
    } else {
      log("info", "TGC reuse — no CAS form shown");
    }

    // Asegurar que estamos en /keraltyadscritos (donde vive el JSESSIONID útil).
    if (!page.url().includes("/keraltyadscritos/")) {
      await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // VERIFICACIÓN CLAVE: ¿tenemos JSESSIONID de Bukeala? Si no, login limpio.
    if (!(await hasBukealaSession(context))) {
      log("warn", "sin JSESSIONID de Bukeala tras intento 1 → login completo limpio");
      await context.clearCookies();
      await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2000);
      if (page.url().includes("/cas/login")) {
        usedCaptcha = await submitCasForm(page, creds, TWO_CAPTCHA_API_KEY, log) || usedCaptcha;
      }
      if (!page.url().includes("/keraltyadscritos/")) {
        await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      if (!(await hasBukealaSession(context))) {
        throw new Error("No se obtuvo JSESSIONID de Bukeala ni con login completo");
      }
    }

    // Confirmación (no bloqueante)
    try {
      const verifyResp = await page.evaluate(async () => {
        const r = await fetch("/keraltyadscritos/findCustomer", { credentials: "include", redirect: "manual" });
        return { status: r.status, type: r.type };
      });
      log("info", "verificación /keraltyadscritos", verifyResp);
    } catch { /* ignore */ }

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

    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": CAPTURE_TOKEN },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Worker rejected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);

    log("info", "session pushed to worker", { status: res.status, cookieCount: filtered.length, usedCaptcha });
    // Guardar storageState COMPLETO (incluye TGC) para el próximo reuso.
    try {
      await context.storageState({ path: STATE_FILE });
      log("info", "storageState saved", { file: STATE_FILE });
    } catch (e) { log("warn", "storageState save failed", { error: e.message }); }

    result = { ok: true, cookieCount: filtered.length, usedCaptcha };
  } catch (e) {
    log("error", "auto-login failed", { error: e.message });
    try { if (APP_DIR) await page.screenshot({ path: path.join(APP_DIR, "last-error.png"), fullPage: true }); } catch {}
    result = { ok: false, reason: e.message };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

module.exports = { runAutoLogin };
