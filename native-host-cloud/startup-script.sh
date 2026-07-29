#!/usr/bin/env bash
# ====================================================================
# Bukeala session keeper — GCE startup script (Debian 12)
# Idempotente: se puede re-correr. Instala todo y arranca el systemd.
# ====================================================================
set -e
exec > /var/log/bukeala-setup.log 2>&1
echo "=== Bukeala setup START $(date) ==="

APP=/opt/bukeala
mkdir -p "$APP"

# --- Node 20 (si no está) ---
if ! command -v node >/dev/null 2>&1; then
  echo "Instalando Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node --version)"

# --- Credenciales desde metadata (no quedan en el script) ---
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
CAS_USERNAME=$(curl -s -H "$HDR" "$META/cas-username")
CAS_PASSWORD=$(curl -s -H "$HDR" "$META/cas-password")
TWO_CAPTCHA_API_KEY=$(curl -s -H "$HDR" "$META/twocaptcha-key")
CAPTURE_TOKEN=$(curl -s -H "$HDR" "$META/capture-token")
WORKER_URL=$(curl -s -H "$HDR" "$META/worker-url")

cat > $APP/package.json <<'PKGEOF'
{
  "name": "bukeala-native-host-cloud",
  "version": "1.0.0",
  "description": "Bukeala session keeper 24/7 en Fly.io (sin PC/Mac prendido)",
  "private": true,
  "scripts": {
    "start": "node watcher.js"
  },
  "dependencies": {
    "playwright": "^1.59.1",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2"
  },
  "engines": {
    "node": ">=18"
  }
}

PKGEOF

cat > $APP/autoLogin.js <<'ALEOF'
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

ALEOF

cat > $APP/watcher.js <<'WEOF'
/**
 * Bukeala Native Host — Cloud Watcher (Fly.io)
 *
 * Proceso long-running 24/7. Dos responsabilidades:
 *
 *  1. KEEP-ALIVE PROACTIVO 24/7: renueva cada PROACTIVE_INTERVAL_MS a cualquier
 *     hora y empuja cookies nuevas al Worker. La sesión expira en ~10-15 min, así que
 *     renovar cada ~10 min la mantiene siempre viva. Mantiene el NAVEGADOR VIVO
 *     entre renovaciones y re-navega en sitio (el TGC de CAS es de un solo uso,
 *     ver autoLogin.js) → renovación normal sin reCAPTCHA. El captcha solo se
 *     gasta en cold start, mantenimiento de Bukeala o reciclaje/crash del browser.
 *
 *  2. ON-DEMAND: cada POLL_INTERVAL_MS consulta /native-host/check-refresh.
 *     Si alguien pidió /sesion_renew por Telegram, hace login inmediato.
 *
 * A diferencia de Windows/Mac, NO hace spawn de un proceso hijo: llama
 * runAutoLogin() en el mismo proceso (un solo contenedor, más simple).
 *
 * Credenciales y config 100% por env vars (Fly secrets):
 *   CAS_USERNAME, CAS_PASSWORD, TWO_CAPTCHA_API_KEY, CAPTURE_TOKEN, WORKER_URL
 * Opcionales:
 *   POLL_INTERVAL_MS        (default 30000  = 30s)
 *   PROACTIVE_INTERVAL_MS   (default 600000 = 10 min)
 */
const os = require("node:os");
const path = require("node:path");
const { runAutoLogin, keepAliveInPlace } = require("./autoLogin");

const APP_DIR = os.tmpdir(); // solo para screenshots de error
// Archivo del TGC de CAS entre renovaciones → la mayoría no usan captcha.
// Vive en el HOME (persiste reboots — /tmp se borraba al reiniciar la VM y
// cada reboot costaba un captcha). Solo guarda la cookie TGC, no el estado
// completo (el estado completo envenenaba la sesión — lección jun 2026).
const STATE_FILE = process.env.STATE_FILE || path.join(os.homedir(), ".bukeala-tgc.json");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const PROACTIVE_INTERVAL_MS = parseInt(process.env.PROACTIVE_INTERVAL_MS || "600000", 10);

function log(level, msg, meta = {}) {
  // Fly captura stdout → `flyctl logs`. JSON de una línea para grep fácil.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
}

function cfg() {
  const c = {
    CAS_USERNAME: process.env.CAS_USERNAME,
    CAS_PASSWORD: process.env.CAS_PASSWORD,
    TWO_CAPTCHA_API_KEY: process.env.TWO_CAPTCHA_API_KEY,
    CAPTURE_TOKEN: process.env.CAPTURE_TOKEN,
    WORKER_URL: process.env.WORKER_URL,
    APP_DIR,
    STATE_FILE,
    log,
  };
  const missing = ["CAS_USERNAME", "CAS_PASSWORD", "TWO_CAPTCHA_API_KEY", "CAPTURE_TOKEN", "WORKER_URL"]
    .filter((k) => !c[k]);
  if (missing.length) throw new Error(`Faltan env vars: ${missing.join(", ")}`);
  return c;
}

function baseUrl(workerUrl) {
  // WORKER_URL llega como .../capture; derivamos la raíz
  return workerUrl.replace(/\/capture$/, "");
}

async function checkForRefreshRequest(c) {
  const url = `${baseUrl(c.WORKER_URL)}/native-host/check-refresh`;
  try {
    const res = await fetch(url, { method: "GET", headers: { "X-Capture-Token": c.CAPTURE_TOKEN } });
    if (!res.ok) { log("warn", "check-refresh non-OK", { status: res.status }); return null; }
    const data = await res.json();
    return data.pending ? data : null;
  } catch (e) {
    log("warn", "check-refresh fetch failed", { error: e.message });
    return null;
  }
}

async function reportComplete(c, ok, message) {
  const url = `${baseUrl(c.WORKER_URL)}/native-host/refresh-complete`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": c.CAPTURE_TOKEN },
      body: JSON.stringify({ ok, message }),
    });
  } catch (e) {
    log("warn", "report-complete failed", { error: e.message });
  }
}

async function reportEvent(c, event) {
  const url = `${baseUrl(c.WORKER_URL)}/native-host/event`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": c.CAPTURE_TOKEN },
      body: JSON.stringify({ at: new Date().toISOString(), ...event }),
    });
  } catch (e) {
    log("warn", "event report failed", { error: e.message });
  }
}

let loginInFlight = false;

// ---- Sesión de navegador VIVA entre renovaciones (jul 2026) ----
// El TGC de CAS es de un solo uso (evidencia en autoLogin.js): la única forma
// de renovar sin captcha es NO crear contexto nuevo. Se conserva el
// browser+context+page que devolvió runAutoLogin y se re-navega en sitio;
// login completo solo cuando la sesión muere o toca reciclarla.
// Solo doLogin toca liveSession (serializado por loginInFlight) → sin carreras.
let liveSession = null;    // { browser, context, page } o null
let liveSessionBornAt = 0; // para reciclaje por edad
let liveSessionUses = 0;   // renovaciones en sitio servidas por esta sesión
// Reciclaje PREVENTIVO (clave para el 24/7) + acota fugas de memoria de
// Chromium en la e2-micro (1 GB RAM).
//
// MEDIDO EN PRODUCCIÓN (29/jul/2026): el CAS de Colsanitas mata el TGC con un
// tope DURO de ~6h (vidas medidas: 372, 364 y 366 min) sin importar la
// actividad. Como todas las renovaciones "en sitio" montan sobre el MISMO TGC,
// al cumplirse esas ~6h el backend tumbaba la sesión A MITAD DE CICLO y
// /agenda quedaba caído 4-10 min hasta el re-login (pasó a las 01:36, 07:42 y
// 13:45 Bogotá; la de las 07:42 fue la que vio el Dr.).
//
// Con reciclaje a 5h20m nos adelantamos al tope: el re-login ocurre cuando NOS
// conviene y la sesión nunca muere sola. NO cuesta captchas extra — es el
// mismo login que CAS iba a forzar de todos modos, solo que controlado.
const LIVE_SESSION_MAX_AGE_MS = 5 * 60 * 60 * 1000 + 20 * 60 * 1000; // 5h20m < ~6h
const LIVE_SESSION_MAX_USES = 30; // ≈5h a cadencia de 10 min (protege si se acorta)

/** Suelta la referencia ANTES de cerrar (nadie debe usarla a medio cerrar). */
async function closeLiveSession(why) {
  const s = liveSession;
  liveSession = null;
  if (!s) return;
  log("info", "cerrando sesión de navegador viva", {
    why, uses: liveSessionUses, ageMin: Math.round((Date.now() - liveSessionBornAt) / 60000),
  });
  try { await s.browser.close(); } catch { /* ya estaba muerto */ }
}

function adoptLiveSession(session) {
  liveSession = session;
  liveSessionBornAt = Date.now();
  liveSessionUses = 0;
  // Si Chromium muere solo (crash/OOM), soltar la referencia para que el
  // próximo ciclo haga login completo en vez de operar sobre un browser muerto.
  // El chequeo de identidad evita pisar una sesión más nueva.
  session.browser.on("disconnected", () => {
    if (liveSession === session) {
      liveSession = null;
      log("warn", "browser vivo se desconectó (crash/OOM); próximo ciclo hará login completo");
    }
  });
}

async function doLogin(c, reason) {
  if (loginInFlight) { log("info", "login already in flight, skip", { reason }); return "skipped"; }
  loginInFlight = true;
  const startedAt = Date.now();
  try {
    log("info", "auto-login start", { reason });

    // 0. Higiene de la sesión viva: reciclar por edad/usos, o soltarla si murió.
    if (liveSession && (Date.now() - liveSessionBornAt >= LIVE_SESSION_MAX_AGE_MS || liveSessionUses >= LIVE_SESSION_MAX_USES)) {
      await closeLiveSession("reciclaje programado");
    } else if (liveSession && !liveSession.browser.isConnected()) {
      await closeLiveSession("browser desconectado");
    }

    // 1. Intento EN SITIO (0 captchas). Aplica también a on-demand: renovar en
    //    la misma sesión de navegador produce cookies igual de frescas.
    let aliveFail = null; // por qué no sirvió la sesión viva (va al evento KV)
    if (liveSession) {
      const ka = await keepAliveInPlace(c, liveSession);
      if (ka.ok) {
        liveSessionUses += 1;
        const durationMs = Date.now() - startedAt;
        log("info", "auto-login OK", { cookieCount: ka.cookieCount, durationMs, reason, via: "alive", uses: liveSessionUses, url: ka.postNavUrl });
        await reportEvent(c, {
          type: "ok", message: `${ka.cookieCount} cookies (cloud, ${reason}, alive)`,
          cookieCount: ka.cookieCount, durationMs,
          via: "alive", fellBack: false, hadBukealaJsession: true, postNavUrl: ka.postNavUrl,
          tgcNewTail: ka.tgcNewTail || undefined,
        });
        return ka;
      }
      // No sirvió (cas-form, crash, etc.): cerrarla ANTES del login completo
      // para no acumular Chromiums, y caer a runAutoLogin (único que puede
      // gastar captcha).
      aliveFail = ka.reason || "unknown";
      log("warn", "keep-alive en sitio no sirvió → login completo", { reason: aliveFail });
      await closeLiveSession(`en sitio: ${aliveFail}`);
    }

    // 2. Login completo, conservando el browser para renovar en sitio después.
    const r = await runAutoLogin(c, { keepAlive: true });
    const durationMs = Date.now() - startedAt;
    if (r.ok && r.session) adoptLiveSession(r.session);
    if (r.ok) {
      // via real reportado por autoLogin: tgc | captcha | captcha-fallback
      const via = r.via || (r.usedCaptcha ? "captcha" : "tgc");
      const tag = via + (r.fellBack ? "+fallback" : "") + (r.tgcSource === "worker" ? "+tgcWorker" : "");
      log("info", "auto-login OK", { cookieCount: r.cookieCount, durationMs, reason, via, fellBack: r.fellBack, tgcSource: r.tgcSource, url: r.postNavUrl });
      await reportEvent(c, {
        type: "ok", message: `${r.cookieCount} cookies (cloud, ${reason}, ${tag})`,
        cookieCount: r.cookieCount, durationMs,
        via, fellBack: !!r.fellBack, hadBukealaJsession: !!r.hadBukealaJsession, postNavUrl: r.postNavUrl,
        tgcSource: r.tgcSource || undefined,
        tgcUsedTail: r.tgcUsedTail || undefined, tgcNewTail: r.tgcNewTail || undefined,
        aliveFail: aliveFail || undefined,
      });
    } else {
      log("error", "auto-login FAIL", { reason: r.reason, durationMs, via: r.via, url: r.postNavUrl });
      await reportEvent(c, {
        type: "error", message: `${r.reason} (cloud, ${reason}, via=${r.via || "?"})`,
        durationMs, via: r.via, fellBack: !!r.fellBack, hadBukealaJsession: !!r.hadBukealaJsession, postNavUrl: r.postNavUrl,
        tgcSource: r.tgcSource || undefined,
        tgcUsedTail: r.tgcUsedTail || undefined, tgcNewTail: r.tgcNewTail || undefined,
        aliveFail: aliveFail || undefined,
      });
    }
    return r;
  } finally {
    loginInFlight = false;
  }
}

async function main() {
  const c = cfg();
  log("info", "cloud watcher started", {
    worker: c.WORKER_URL,
    user: c.CAS_USERNAME,
    pollMs: POLL_INTERVAL_MS,
    proactiveMs: PROACTIVE_INTERVAL_MS,
  });

  // ESTRATEGIA 24/7 (navegador vivo):
  // La renovación normal es EN SITIO sobre la sesión de navegador viva (0
  // captchas). Si murió (crash, reciclaje, mantenimiento de Bukeala) se hace
  // login completo, que siembra el TGC guardado si aún sirve (un solo uso,
  // <15 min) y si no gasta captcha. Keep-alive cada PROACTIVE_INTERVAL_MS a
  // toda hora; on-demand a cualquier hora.
  let lastProactiveAt = Date.now();   // último keep-alive EXITOSO (el startup cuenta)
  let lastAttemptAt = Date.now();     // último INTENTO (éxito o fallo)
  let renewFailing = false;           // true si el último intento falló → reintentar con backoff
  let consecutiveFails = 0;           // fallos seguidos (escala el backoff)
  let fatalReason = null;             // p.ej. ZERO_BALANCE → backoff largo (requiere humano)
  const RETRY_DELAY_MS = 90 * 1000;   // tras un fallo normal, reintentar en 90s
  // Errores que NO se arreglan reintentando (requieren acción humana, p.ej. recargar saldo):
  const FATAL_PATTERNS = [/ZERO_BALANCE/i];

  // Delay del próximo reintento tras fallo. Normal: 90s. Fallos repetidos
  // (5+): 10 min — martillar cada 90s nos ganó "Too Many Requests" de
  // 2Captcha/CAS. Fatal (sin saldo): escalera 15 → 30 → 60 min.
  function retryDelayMs() {
    if (fatalReason) {
      const ladder = [15, 30, 60];
      return ladder[Math.min(Math.max(consecutiveFails - 1, 0), ladder.length - 1)] * 60 * 1000;
    }
    if (consecutiveFails >= 5) return 10 * 60 * 1000;
    return RETRY_DELAY_MS;
  }

  function noteResult(r) {
    if (r === "skipped") return;
    if (r && r.ok) {
      lastProactiveAt = Date.now();
      renewFailing = false; consecutiveFails = 0; fatalReason = null;
      return;
    }
    renewFailing = true;
    consecutiveFails += 1;
    const reason = (r && r.reason) || "";
    fatalReason = FATAL_PATTERNS.some((p) => p.test(reason)) ? reason : null;
    if (fatalReason) {
      log("error", "fallo FATAL — backoff largo hasta acción humana", {
        reason: fatalReason,
        nextRetryMin: Math.round(retryDelayMs() / 60000),
      });
    }
  }

  // Login inmediato al arrancar (sesión fresca de una)
  noteResult(await doLogin(c, "startup"));

  while (true) {
    try {
      // 1. ¿Refresh on-demand pedido (Telegram, WhatsApp entrante, MCP)?
      //    24/7 y SIN backoff: siempre se intenta ya — un humano pudo haber
      //    recargado el saldo y /sesion_renew debe funcionar de inmediato.
      const req = await checkForRefreshRequest(c);
      if (req) {
        log("info", "refresh requested", { by: String(req.requestedBy || ""), at: req.requestedAt });
        const r = await doLogin(c, "on-demand");
        // "skipped" = ya había un login en curso (no es un fallo) → no reportar error.
        if (r !== "skipped") await reportComplete(c, !!(r && r.ok), r && r.ok ? "cloud login OK" : "cloud login failed");
        lastAttemptAt = Date.now();
        noteResult(r);
      }

      // 2. KEEP-ALIVE con backoff. OJO: mientras renewFailing, el intervalo
      //    normal NO dispara (antes sí: lastProactiveAt solo avanza con éxito,
      //    así que tras 10 min fallando se intentaba en CADA tick de 30s —
      //    esa fue la tormenta de reintentos del 28/jul).
      const intervalDue = !renewFailing && Date.now() - lastProactiveAt >= PROACTIVE_INTERVAL_MS;
      const retryDue = renewFailing && Date.now() - lastAttemptAt >= retryDelayMs();
      if (intervalDue || retryDue) {
        log("info", retryDue ? `keep-alive (reintento tras ${consecutiveFails} fallo(s))` : "keep-alive");
        const res = await doLogin(c, "keep-alive");
        lastAttemptAt = Date.now();
        noteResult(res);
      }
    } catch (e) {
      log("error", "tick failed", { error: e.message });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  log("error", "fatal", { error: err.message, stack: err.stack });
  process.exit(2);
});

WEOF

cd "$APP"
echo "npm install..."
npm install --omit=dev --no-audit --no-fund

# Chromium + dependencias del SO via playwright.
# CRÍTICO: PLAYWRIGHT_BROWSERS_PATH debe coincidir con el del systemd unit
# (/root/.cache/ms-playwright) y correr DESPUÉS de npm install para que use
# la versión de playwright fijada en package.json (no una efímera de npx).
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
echo "Instalando Chromium + deps del SO..."
npx playwright install --with-deps chromium

# --- Swap 1GB (la e2-micro tiene 1GB de RAM y Chromium vive 24/7) ---
# Sin swap, un pico de memoria mata Chromium: el ciclo siguiente hace login
# completo (gasta captcha) y deja un hueco de agenda. Idempotente.
if [ ! -f /swapfile ]; then
  echo "Creando swap de 1GB..."
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show || true

# --- Logrotate del log del watcher ---
# El watcher escribe JSON en cada tick a /var/log/bukeala.log (append, sin
# rotación): a la larga llena el disco y Chromium entra en crash loop.
cat > /etc/logrotate.d/bukeala <<'LOGROT'
/var/log/bukeala.log /var/log/bukeala-setup.log {
  daily
  rotate 7
  maxsize 50M
  compress
  missingok
  notifempty
  copytruncate
}
LOGROT

# systemd service
cat > /etc/systemd/system/bukeala.service <<UNIT
[Unit]
Description=Bukeala session keeper (cloud watcher)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
Environment=CAS_USERNAME=$CAS_USERNAME
Environment=CAS_PASSWORD=$CAS_PASSWORD
Environment=TWO_CAPTCHA_API_KEY=$TWO_CAPTCHA_API_KEY
Environment=CAPTURE_TOKEN=$CAPTURE_TOKEN
Environment=WORKER_URL=$WORKER_URL
Environment=POLL_INTERVAL_MS=30000
# 10 min: la sesión de Bukeala vive ~10-15 min, con 15 min quedaban ventanas
# muertas entre renovaciones. Renovar es gratis (navegador vivo).
Environment=PROACTIVE_INTERVAL_MS=600000
Environment=PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ExecStart=/usr/bin/node $APP/watcher.js
Restart=always
RestartSec=15
StandardOutput=append:/var/log/bukeala.log
StandardError=append:/var/log/bukeala.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable bukeala.service
systemctl restart bukeala.service
echo "=== Bukeala setup DONE $(date) ==="
systemctl status bukeala.service --no-pager || true
