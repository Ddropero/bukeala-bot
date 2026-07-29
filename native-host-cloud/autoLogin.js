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

/**
 * Guarda SOLO la cookie TGC. Devuelve los últimos 12 chars del valor guardado
 * (huella para rastrear identidad del token entre renovaciones) o false.
 */
async function saveTgc(context, STATE_FILE, log) {
  const cks = await context.cookies();
  const tgc = cks.filter((c) => isTgcName(c.name));
  if (tgc.length === 0) { log("warn", "no TGC cookie to save"); return false; }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies: tgc, origins: [] }));
    const tail = (tgc[0].value || "").slice(-12);
    log("info", "TGC saved", { count: tgc.length, tail });
    return tail;
  } catch (e) { log("warn", "save TGC failed", { error: e.message }); return false; }
}

function loadTgc(STATE_FILE) {
  // Busca el TGC en el archivo configurado y, si no está, en la ruta legacy
  // de /tmp (versiones viejas lo guardaban ahí y un reboot lo borraba).
  const candidates = [STATE_FILE, path.join(os.tmpdir(), "bukeala-tgc.json")];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const tgc = (raw.cookies || []).filter((c) => isTgcName(c.name));
      if (tgc.length) return { cookies: tgc, origins: [] };
    } catch { /* probar siguiente */ }
  }
  return null;
}

/**
 * Rescate de TGC desde el Worker: la última sesión que la VM empujó a KV
 * (TTL 12h) incluye la cookie CASTGC. Si el archivo local se perdió (reboot),
 * esto evita gastar un captcha para re-bootstrapear.
 */
async function fetchTgcFromWorker(WORKER_URL, CAPTURE_TOKEN, log) {
  try {
    const base = WORKER_URL.replace(/\/capture$/, "");
    const res = await fetch(`${base}/native-host/tgc`, {
      headers: { "X-Capture-Token": CAPTURE_TOKEN },
    });
    if (!res.ok) { log("warn", "worker TGC fetch non-OK", { status: res.status }); return null; }
    const data = await res.json();
    if (!data.found || !Array.isArray(data.cookies) || data.cookies.length === 0) {
      log("info", "worker no tiene TGC para rescatar", { reason: data.reason });
      return null;
    }
    log("info", "TGC rescatado del Worker", { capturedAt: data.capturedAt, count: data.cookies.length });
    return { cookies: data.cookies, origins: [] };
  } catch (e) {
    log("warn", "worker TGC fetch failed", { error: e.message });
    return null;
  }
}

/** Normaliza una cookie (del archivo o del Worker) para context.addCookies(). */
function toPlaywrightCookie(c) {
  const ck = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: c.secure !== undefined ? !!c.secure : true, // CASTGC es Secure
  };
  if (typeof c.expires === "number" && c.expires > 0) ck.expires = c.expires;
  if (c.sameSite) ck.sameSite = c.sameSite;
  return ck;
}

/**
 * Login completo (TGC → fallback captcha).
 *
 * `opts.keepAlive === true`: si el login es exitoso, NO cierra el browser y
 * devuelve `session: { browser, context, page }` para que el llamador renueve
 * en sitio (ver keepAliveInPlace). Se eligió un 2º parámetro y no un flag en
 * `env` porque `env` es config compartida entre llamadas (cfg() del watcher)
 * y esto es comportamiento por-llamada. En fallo o modo legacy cierra como
 * siempre: cero fugas de Chromium.
 */
async function runAutoLogin(env, opts = {}) {
  const keepAlive = opts.keepAlive === true;
  const { CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL, log } = env;
  if (!CAS_USERNAME || !CAS_PASSWORD) return { ok: false, reason: "CAS_USERNAME/CAS_PASSWORD missing" };
  if (!TWO_CAPTCHA_API_KEY) return { ok: false, reason: "TWO_CAPTCHA_API_KEY missing" };
  if (!CAPTURE_TOKEN || !WORKER_URL) return { ok: false, reason: "CAPTURE_TOKEN/WORKER_URL missing" };

  const creds = { username: CAS_USERNAME, password: CAS_PASSWORD };
  // Default en el HOME (persiste reboots). /tmp era el default viejo: cada
  // reinicio de la VM borraba el TGC → captcha para re-bootstrapear.
  const STATE_FILE = env.STATE_FILE || path.join(os.homedir(), ".bukeala-tgc.json");
  log("info", "credentials from env", { user: creds.username });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  const diag = {
    via: "captcha", postNavUrl: null, hadBukealaJsession: false, fellBack: false,
    tgcSaved: false, tgcSource: null,
    // Huellas (últimos 12 chars de la firma JWT) para rastrear la identidad
    // del token entre renovaciones: ¿presentamos el token correcto? ¿CAS lo
    // rotó al reusarlo? Sin esto no se puede distinguir bug de guardado vs
    // política del servidor.
    tgcUsedTail: null, tgcNewTail: null,
  };
  let result = { ok: false };
  let keepOpen = false; // true solo si el login OK y el llamador conserva la sesión

  try {
    // ---- INTENTO 1: restaurar SOLO la cookie TGC ----
    // Orden: archivo local → rescate desde el Worker (si el archivo se perdió,
    // p.ej. tras un reboot cuando vivía en /tmp) → sin TGC (captcha directo).
    let savedTgc = loadTgc(STATE_FILE);
    diag.tgcSource = savedTgc ? "file" : null;
    if (!savedTgc) {
      savedTgc = await fetchTgcFromWorker(WORKER_URL, CAPTURE_TOKEN, log);
      if (savedTgc) diag.tgcSource = "worker";
    }
    if (savedTgc) diag.tgcUsedTail = (savedTgc.cookies[0]?.value || "").slice(-12) || null;
    const ctx1 = await browser.newContext({ ...CONTEXT_OPTIONS });
    if (savedTgc) await ctx1.addCookies(savedTgc.cookies.map(toPlaywrightCookie));
    log("info", savedTgc ? `TGC restaurado (fuente: ${diag.tgcSource})` : "sin TGC previo");
    const page1 = await ctx1.newPage();
    const nav1 = await navigateAndLogin(page1, creds, TWO_CAPTCHA_API_KEY, log);
    diag.postNavUrl = nav1.postNavUrl;
    await waitForBukealaSession(ctx1, SESSION_WAIT_MS); // espera activa por la cookie
    diag.hadBukealaJsession = (await hasBukealaSession(ctx1)) && looksAuthenticated(page1.url());
    diag.via = nav1.usedCaptcha ? "captcha" : "tgc";

    let activeCtx = ctx1;
    let activePage = page1;

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
      activePage = page2;
      if (!diag.hadBukealaJsession) throw new Error(`No JSESSIONID de Bukeala ni con fallback (url=${page2.url()})`);
    }

    const cookieCount = await captureAndPush(activeCtx, WORKER_URL, CAPTURE_TOKEN, log);
    const savedTail = await saveTgc(activeCtx, STATE_FILE, log);
    diag.tgcSaved = !!savedTail;
    diag.tgcNewTail = savedTail || null;

    log("info", "auto-login OK", diag);
    result = { ok: true, cookieCount, usedCaptcha: diag.via !== "tgc", ...diag };
    if (keepAlive) {
      // Entregar la sesión viva: el contexto ACTIVO real (ctx2 si hubo
      // fallback — ctx1 ya se cerró en esa rama). El llamador es dueño del
      // browser desde aquí y debe cerrarlo él (closeLiveSession del watcher).
      keepOpen = true;
      result.session = { browser, context: activeCtx, page: activePage };
    }
  } catch (e) {
    log("error", "auto-login failed", { error: e.message, diag });
    result = { ok: false, reason: e.message, ...diag };
  } finally {
    if (!keepOpen) await browser.close().catch(() => {});
  }
  return result;
}

// ====================================================================
// Renovación EN SITIO con navegador vivo (jul 2026)
// ====================================================================
//
// Evidencia (huellas TGC medidas el 28/jul en producción): el TGC JWT de
// Colsanitas es de UN SOLO USO y vida ≤ ~15 min (1er uso a 5 y 14.4 min → OK;
// 2º uso del mismo token a 5.8 y 10.8 min → rechazado; 1er uso a 16.5 min →
// rechazado). Y CAS NO rota el valor al reusarlo (usado == nuevo), así que
// guardar el TGC en archivo y restaurarlo en un contexto NUEVO alterna
// captcha/tgc y nunca baja a 0 captchas.
//
// En cambio, un browser+context+page VIVOS entre renovaciones presentan a CAS
// siempre la misma sesión de navegador: re-navegar a Bukeala cada ~10 min
// renueva el ticket sin form → 0 captchas. El captcha queda solo para: cold
// start, mantenimiento nocturno de Bukeala y crash/reciclaje del navegador.
// El TGC guardado se sigue sembrando en el cold start (un solo uso, pero
// gratis si el token tiene <15 min — p.ej. tras un restart rápido).

/**
 * Renueva la sesión EN SITIO: re-navega BUKEALA_HOME en la MISMA page de una
 * sesión viva `{ browser, context, page }` (la que devolvió runAutoLogin con
 * `{ keepAlive: true }`). NUNCA lanza y NUNCA gasta captcha:
 *  - sin sesión utilizable, o si aparece el form CAS, o ante cualquier error
 *    → { ok:false, needsFullLogin:true, reason } (el watcher decide hacer el
 *    login completo, que es el único que puede gastar captcha);
 *  - si sigue autenticado → empuja cookies al Worker + guarda TGC y devuelve
 *    { ok:true, via:"alive", ... } (mismos campos de diagnóstico que el resto).
 */
async function keepAliveInPlace(env, session) {
  try {
    const { CAPTURE_TOKEN, WORKER_URL, log } = env;
    const STATE_FILE = env.STATE_FILE || path.join(os.homedir(), ".bukeala-tgc.json");
    if (!session || !session.browser || !session.context || !session.page) {
      return { ok: false, needsFullLogin: true, reason: "sin sesión viva" };
    }
    const { browser, context, page } = session;
    // Chromium pudo morir entre renovaciones (crash/OOM en la e2-micro).
    if (!browser.isConnected()) return { ok: false, needsFullLogin: true, reason: "browser desconectado" };
    if (page.isClosed()) return { ok: false, needsFullLogin: true, reason: "page cerrada" };

    // Misma secuencia de navegación que navigateAndLogin, pero SIN submitCasForm:
    // si CAS pide form aquí, la sesión de navegador ya no sirve y gastar el
    // captcha le toca al login completo (con su fallback probado), no a esta ruta.
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    const postNavUrl = page.url();
    log("info", "keep-alive en sitio: after navigation", { url: postNavUrl });
    if (postNavUrl.includes("/cas/login")) {
      return { ok: false, needsFullLogin: true, reason: "cas-form", postNavUrl };
    }
    // Asegurar /keraltyadscritos (donde vive el JSESSIONID útil).
    if (!page.url().includes("/keraltyadscritos/")) {
      await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    await waitForBukealaSession(context, SESSION_WAIT_MS); // espera activa por la cookie
    const authed = (await hasBukealaSession(context)) && looksAuthenticated(page.url());
    if (!authed) {
      return { ok: false, needsFullLogin: true, reason: `sin sesión Bukeala en sitio (url=${page.url()})`, postNavUrl };
    }

    const cookieCount = await captureAndPush(context, WORKER_URL, CAPTURE_TOKEN, log);
    const savedTail = await saveTgc(context, STATE_FILE, log);
    return {
      ok: true, cookieCount, via: "alive",
      postNavUrl, hadBukealaJsession: true,
      tgcSaved: !!savedTail, tgcNewTail: savedTail || null,
    };
  } catch (e) {
    // Nunca propagar: el watcher corre 24/7 y decide el fallback.
    return { ok: false, needsFullLogin: true, reason: e.message };
  }
}

module.exports = { runAutoLogin, keepAliveInPlace };
