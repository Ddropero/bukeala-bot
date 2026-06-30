/**
 * Auto-login para la VM (Google Cloud) — TGC con fallback seguro + diagnóstico.
 *
 * Env: CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL.
 * Opcional: STATE_FILE (default /tmp/bukeala-tgc.json).
 *
 * OBJETIVO: capturar el JSESSIONID de BUKEALA (appoint.tuscitasmedicas.com). El
 * del CAS (app01.colsanitas.com) es inútil y, si se cuela, rompe la sesión.
 *
 * Flujo (con lecciones de 2 intentos fallidos + revisión adversarial):
 *  1. INTENTO 1: contexto con SOLO la cookie TGC restaurada (no todas, que
 *     envenenaban). Navega BUKEALA_HOME; si sale el form CAS → captcha; si no,
 *     CAS reusa el TGC y emite el ticket. Espera ACTIVA por el JSESSIONID de
 *     Bukeala (no timeout fijo: el intercambio ticket→cookie es asíncrono).
 *  2. VERIFICA sesión REAL de Bukeala (cookie tuscitasmedicas + URL en
 *     /keraltyadscritos, no /cas/login ni /authentication/login).
 *  3. FALLBACK SEGURO (solo si el intento 1 NO usó captcha — evita doble gasto):
 *     contexto FRESCO sin cookies + login con captcha probado.
 *  4. captureAndPush DESCARTA cualquier JSESSIONID que no sea de Bukeala.
 *  5. Guarda SOLO la cookie TGC para el próximo reuso.
 *
 * DIAGNÓSTICO REMOTO (la VM no logea a journald): devuelve { via, fellBack,
 * hadBukealaJsession, postNavUrl, tgcSaved } y el watcher los manda al evento KV.
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
const SESSION_WAIT_MS = 10000; // espera activa por el JSESSIONID de Bukeala

const BUKEALA_HOME =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

// Prefijos de cookie que constituyen el TGC de CAS (match flexible).
const TGC_PREFIXES = ["TGC", "CASTGC"];
const isTgcName = (n) => TGC_PREFIXES.some((p) => (n || "").toUpperCase().startsWith(p));

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
  log("info", "submitting reCAPTCHA to 2Captcha", { sitekey });
  const submitParams = new URLSearchParams({
    key: twoCaptchaKey, method: "userrecaptcha", googlekey: sitekey, pageurl: pageUrl, json: "1",
  });
  const subRes = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${submitParams}`);
  const subJson = await subRes.json();
  if (subJson.status !== 1) {
    // Saldo agotado u otro error fatal: propagar claro para abortar el ciclo.
    throw new Error(`2Captcha submit failed: ${subJson.request ?? "unknown"}`);
  }
  const captchaId = subJson.request;
  const startedAt = Date.now();
  while (Date.now() - startedAt < TWO_CAPTCHA_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, TWO_CAPTCHA_POLL_INTERVAL_MS));
    const pollRes = await fetch(`${TWO_CAPTCHA_BASE}/res.php?key=${twoCaptchaKey}&action=get&id=${captchaId}&json=1`);
    const pollJson = await pollRes.json();
    if (pollJson.status === 1) { log("info", "2Captcha solved", { elapsedMs: Date.now() - startedAt }); return pollJson.request; }
    if (pollJson.request !== "CAPCHA_NOT_READY") throw new Error(`2Captcha poll failed: ${pollJson.request}`);
  }
  throw new Error("2Captcha timeout (>2 min)");
}

/** ¿El contexto tiene un JSESSIONID de Bukeala (dominio tuscitasmedicas)? */
async function hasBukealaSession(context) {
  const cks = await context.cookies();
  return cks.some((c) => c.name === "JSESSIONID" && (c.domain || "").toLowerCase().includes("tuscitasmedicas"));
}

/** ¿Estamos en una página de Bukeala autenticada (no login)? */
function looksAuthenticated(url) {
  return url.includes("/keraltyadscritos/") && !url.includes("/cas/login") && !url.includes("/authentication/login");
}

/** Espera ACTIVA: hasta timeoutMs por el JSESSIONID de Bukeala (poll 500ms). */
async function waitForBukealaSession(context, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await hasBukealaSession(context)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return await hasBukealaSession(context);
}

/** Llena el formulario CAS (user+pass+reCAPTCHA) y envía. Lanza si el login falla. */
async function submitCasForm(page, creds, key, log) {
  log("info", "at CAS login, filling credentials");
  const userSel = 'input[name="username"], input#username';
  const passSel = 'input[name="password"], input#password';
  const submitSel = 'button[type="submit"], input[type="submit"], button[name="submit"]';
  await page.waitForSelector(userSel, { timeout: 30_000 });
  await page.fill(userSel, creds.username);
  await page.fill(passSel, creds.password);
  const sitekey = await page.$eval(".g-recaptcha, [data-sitekey]", (el) => el.getAttribute("data-sitekey")).catch(() => null);
  if (sitekey) {
    log("info", "reCAPTCHA detected");
    const token = await solveRecaptcha(key, sitekey, page.url(), log);
    await page.evaluate((t) => {
      let el = document.getElementById("g-recaptcha-response");
      if (!el) { el = document.createElement("textarea"); el.id = "g-recaptcha-response"; el.name = "g-recaptcha-response"; el.style.display = "none"; document.body.appendChild(el); }
      el.value = t; el.innerHTML = t;
      if (typeof window.___grecaptcha_cfg !== "undefined" && window.___grecaptcha_cfg.clients) {
        const clients = window.___grecaptcha_cfg.clients;
        for (const cid in clients) for (const k in clients[cid]) {
          if (typeof clients[cid][k] === "object") for (const k2 in clients[cid][k]) {
            if (typeof clients[cid][k][k2] === "object" && clients[cid][k][k2] && typeof clients[cid][k][k2].callback === "function") {
              try { clients[cid][k][k2].callback(t); } catch {}
            }
          }
        }
      }
    }, token);
  } else {
    log("info", "no reCAPTCHA detected, submitting directly");
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
    page.click(submitSel),
  ]);
  await page.waitForTimeout(2000);
  // Chequeo de fallo de login (credenciales malas / captcha rechazado / mantenimiento).
  const finalUrl = page.url();
  if (finalUrl.includes("/cas/login") && !finalUrl.includes("ticket=")) {
    const errorText = await page.locator(".alert-danger, .errors, .login-error").first().textContent().catch(() => null);
    throw new Error(`Login CAS falló (sigue en /cas/login): ${errorText ? errorText.trim().slice(0, 120) : "sin detalle"}`);
  }
}

/** Navega a Bukeala; si sale el form CAS hace login. Devuelve { usedCaptcha, postNavUrl }. */
async function navigateAndLogin(page, creds, key, log) {
  await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);
  const postNavUrl = page.url();
  log("info", "after navigation", { url: postNavUrl });
  let usedCaptcha = false;
  if (postNavUrl.includes("/cas/login")) {
    await submitCasForm(page, creds, key, log);
    usedCaptcha = true;
  } else {
    log("info", "no CAS form (TGC reuse o ya autenticado)");
  }
  // Asegurar /keraltyadscritos (donde vive el JSESSIONID útil).
  if (!page.url().includes("/keraltyadscritos/")) {
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  return { usedCaptcha, postNavUrl };
}

/** Captura cookies relevantes y las empuja al Worker. DESCARTA JSESSIONID no-Bukeala. */
async function captureAndPush(context, WORKER_URL, CAPTURE_TOKEN, log) {
  const cookies = await context.cookies();
  const filtered = cookies.filter((c) => {
    const d = (c.domain || "").toLowerCase();
    if (!(d.includes("tuscitasmedicas.com") || d.includes("colsanitas.com"))) return false;
    // NUNCA empujar el JSESSIONID del CAS (rompe la sesión en el Worker).
    if (c.name === "JSESSIONID" && !d.includes("tuscitasmedicas")) return false;
    return true;
  });
  if (filtered.length === 0) throw new Error("No relevant cookies captured");
  const payload = {
    capturedAt: new Date().toISOString(),
    cookies: filtered.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly,
    })),
  };
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Capture-Token": CAPTURE_TOKEN },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Worker rejected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  log("info", "session pushed", { status: res.status, cookieCount: filtered.length });
  return filtered.length;
}

/** Guarda SOLO la cookie TGC. Devuelve true si guardó algo. */
async function saveTgc(context, STATE_FILE, log) {
  const cks = await context.cookies();
  const tgc = cks.filter((c) => isTgcName(c.name));
  if (tgc.length === 0) { log("warn", "no TGC cookie to save"); return false; }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies: tgc, origins: [] })); log("info", "TGC saved", { count: tgc.length }); return true; }
  catch (e) { log("warn", "save TGC failed", { error: e.message }); return false; }
}

function loadTgc(STATE_FILE) {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const tgc = (raw.cookies || []).filter((c) => isTgcName(c.name));
    return tgc.length ? { cookies: tgc, origins: [] } : null;
  } catch { return null; }
}

async function runAutoLogin(env) {
  const { CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL, log } = env;
  if (!CAS_USERNAME || !CAS_PASSWORD) return { ok: false, reason: "CAS_USERNAME/CAS_PASSWORD missing" };
  if (!TWO_CAPTCHA_API_KEY) return { ok: false, reason: "TWO_CAPTCHA_API_KEY missing" };
  if (!CAPTURE_TOKEN || !WORKER_URL) return { ok: false, reason: "CAPTURE_TOKEN/WORKER_URL missing" };

  const creds = { username: CAS_USERNAME, password: CAS_PASSWORD };
  const STATE_FILE = env.STATE_FILE || path.join(os.tmpdir(), "bukeala-tgc.json");
  log("info", "credentials from env", { user: creds.username });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  const diag = { via: "captcha", postNavUrl: null, hadBukealaJsession: false, fellBack: false, tgcSaved: false };
  let result = { ok: false };

  try {
    // ---- INTENTO 1: restaurar SOLO la cookie TGC ----
    const savedTgc = loadTgc(STATE_FILE);
    const ctx1 = await browser.newContext(savedTgc ? { ...CONTEXT_OPTIONS, storageState: savedTgc } : { ...CONTEXT_OPTIONS });
    log("info", savedTgc ? "TGC restaurado (solo cookie TGC)" : "sin TGC previo");
    const page1 = await ctx1.newPage();
    const nav1 = await navigateAndLogin(page1, creds, TWO_CAPTCHA_API_KEY, log);
    diag.postNavUrl = nav1.postNavUrl;
    await waitForBukealaSession(ctx1, SESSION_WAIT_MS); // espera activa por la cookie
    diag.hadBukealaJsession = (await hasBukealaSession(ctx1)) && looksAuthenticated(page1.url());
    diag.via = nav1.usedCaptcha ? "captcha" : "tgc";

    let activeCtx = ctx1;

    if (!diag.hadBukealaJsession) {
      if (nav1.usedCaptcha) {
        // Ya gastamos un captcha y aun así no hay sesión de Bukeala: un 2º captcha
        // rara vez ayuda. Fallar y reportar (evita doble gasto / saldo agotado).
        throw new Error(`Login con captcha no produjo sesión de Bukeala (url=${page1.url()})`);
      }
      // El TGC no dio sesión → FALLBACK contexto FRESCO + login probado.
      log("warn", "TGC no dio sesión de Bukeala → fallback contexto fresco");
      diag.fellBack = true;
      diag.via = "captcha-fallback";
      await ctx1.close().catch(() => {});
      const ctx2 = await browser.newContext({ ...CONTEXT_OPTIONS });
      const page2 = await ctx2.newPage();
      await navigateAndLogin(page2, creds, TWO_CAPTCHA_API_KEY, log);
      await waitForBukealaSession(ctx2, SESSION_WAIT_MS);
      diag.hadBukealaJsession = (await hasBukealaSession(ctx2)) && looksAuthenticated(page2.url());
      activeCtx = ctx2;
      if (!diag.hadBukealaJsession) throw new Error(`No JSESSIONID de Bukeala ni con fallback (url=${page2.url()})`);
    }

    const cookieCount = await captureAndPush(activeCtx, WORKER_URL, CAPTURE_TOKEN, log);
    diag.tgcSaved = await saveTgc(activeCtx, STATE_FILE, log);

    log("info", "auto-login OK", diag);
    result = { ok: true, cookieCount, usedCaptcha: diag.via !== "tgc", ...diag };
  } catch (e) {
    log("error", "auto-login failed", { error: e.message, diag });
    result = { ok: false, reason: e.message, ...diag };
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

module.exports = { runAutoLogin };
