/**
 * Auto-login flow para la NUBE (Fly.io).
 *
 * Diferencia clave vs Windows/Mac: las credenciales NO se cifran en disco.
 * Vienen directo de variables de entorno (Fly secrets), que ya están
 * cifradas en reposo por la plataforma. Así no hay master key ni creds.dat.
 *
 * Env vars requeridas:
 *   CAS_USERNAME          usuario CAS Colsanitas (ej. 80040718.prest)
 *   CAS_PASSWORD          password CAS
 *   TWO_CAPTCHA_API_KEY   key de 2Captcha
 *   CAPTURE_TOKEN         token compartido con el Worker
 *   WORKER_URL            https://bukeala-bot.ddropero.workers.dev/capture
 *
 * Flow idéntico al de siempre:
 *   Chromium headless stealth → CAS → user+pass → reCAPTCHA (2Captcha)
 *   → submit → bind /keraltyadscritos → captura cookies → push al Worker.
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

// URL de login CAS con el service de Bukeala. Navegar aquí FUERZA el flujo de
// ticket: con un TGC válido (restaurado vía storageState) CAS emite un service
// ticket SIN pedir login/captcha → redirige a Bukeala?ticket=ST-... → Bukeala
// valida y emite un JSESSIONID FRESCO de appoint.tuscitasmedicas.com. Esto es
// lo que faltaba: navegar directo a BUKEALA_HOME no forzaba el ticket y solo
// quedaba el JSESSIONID del CAS (inútil para el Worker). Si el TGC expiró, CAS
// muestra el formulario (y ahí sí se resuelve el reCAPTCHA).
const CAS_LOGIN_URL =
  "https://app01.colsanitas.com/cas/login?service=" + encodeURIComponent(BUKEALA_HOME);

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

/**
 * @param {object} env  { CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY,
 *                        CAPTURE_TOKEN, WORKER_URL, APP_DIR, log }
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
  log("info", "credentials from env", { user: creds.username });

  const STATE_FILE = env.STATE_FILE || path.join(os.tmpdir(), "bukeala-state.json");
  const LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ];

  // storageState: guardamos/restauramos TODAS las cookies (incluida CASTGC, que
  // es cookie de SESIÓN — un perfil normal la descarta al cerrar Chromium). Al
  // restaurar el TGC, CAS emite una sesión nueva SIN login ni reCAPTCHA (~5s).
  // Si no hay archivo o el TGC expiró, se hace login completo (captcha) y se
  // vuelve a guardar. La carpeta /tmp siempre es escribible (evita líos de
  // permisos). Nunca peor que antes (en el peor caso = captcha como hoy).
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctxOptions = { ...CONTEXT_OPTIONS };
  let restoredState = false;
  try {
    if (fs.existsSync(STATE_FILE)) { ctxOptions.storageState = STATE_FILE; restoredState = true; }
  } catch { /* ignore */ }
  const context = await browser.newContext(ctxOptions);
  log("info", restoredState ? "cookies restored (storageState)" : "no prior state (fresh login)", { file: STATE_FILE });
  const page = await context.newPage();

  let result = { ok: false };
  let usedCaptcha = false;

  try {
    log("info", "navigating to CAS service-login (forces fresh Bukeala JSESSIONID)");
    await page.goto(CAS_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);
    const url = page.url();
    log("info", "after navigation", { url });

    if (url.includes("appoint.tuscitasmedicas.com") && !url.includes("/cas/login")) {
      // CAS aceptó el TGC, emitió el ticket y Bukeala ya nos validó →
      // JSESSIONID FRESCO de Bukeala. Cero captcha. Ruta barata/rápida.
      log("info", "TGC reuse — service ticket OK, fresh Bukeala session (no captcha)");
    } else {
      log("info", "at CAS login, filling credentials");
      const userSel = 'input[name="username"], input#username';
      const passSel = 'input[name="password"], input#password';
      const submitSel = 'button[type="submit"], input[type="submit"], button[name="submit"]';

      await page.waitForSelector(userSel, { timeout: 30_000 });
      await page.fill(userSel, creds.username);
      await page.fill(passSel, creds.password);

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

      const finalUrl = page.url();
      log("info", "after submit", { url: finalUrl });

      if (finalUrl.includes("/cas/login") && !finalUrl.includes("ticket=")) {
        const errorText = await page
          .locator(".alert-danger, .errors, .login-error")
          .first().textContent().catch(() => null);
        throw new Error(`Login failed (still at CAS): ${errorText ?? "unknown"}`);
      }
    }

    // Bind del JSESSIONID de /keraltyadscritos
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

    try {
      const verifyResp = await page.evaluate(async () => {
        const r = await fetch("/keraltyadscritos/findCustomer", {
          credentials: "include", redirect: "manual",
        });
        return { status: r.status, type: r.type, ok: r.ok };
      });
      log("info", "verificación /keraltyadscritos", verifyResp);
    } catch (e) {
      log("warn", "verificación falló (no bloqueante)", { error: e.message });
    }

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
    // Persistir cookies (incl. TGC) para que la próxima renovación no use captcha.
    try {
      await context.storageState({ path: STATE_FILE });
      log("info", "storageState saved", { file: STATE_FILE });
    } catch (e) {
      log("warn", "storageState save failed", { error: e.message });
    }
    result = { ok: true, cookieCount: filtered.length, usedCaptcha };
  } catch (e) {
    log("error", "auto-login failed", { error: e.message });
    try {
      if (APP_DIR) await page.screenshot({ path: path.join(APP_DIR, "last-error.png"), fullPage: true });
    } catch {/* ignore */}
    result = { ok: false, reason: e.message };
  } finally {
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

module.exports = { runAutoLogin };
