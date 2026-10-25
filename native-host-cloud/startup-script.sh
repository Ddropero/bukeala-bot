#!/usr/bin/env bash
# ====================================================================
# Bukeala session keeper — GCE startup script (Debian 12)
# Idempotente: se puede re-correr. Instala todo y arranca el systemd.
# ====================================================================
set -e
exec > /var/log/bukeala-setup.log 2>&1
echo "=== Bukeala setup START $(date) ==="

APP=/opt/bukeala
mkdir -p "$APP" /var/lib/bukeala/browser-profile
chmod 700 /var/lib/bukeala /var/lib/bukeala/browser-profile

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
BROWSER_SESSION_MODE=$(curl -fsS -H "$HDR" "$META/browser-session-mode" 2>/dev/null || true)
ENABLE_FULL_LOGIN=$(curl -fsS -H "$HDR" "$META/enable-full-login" 2>/dev/null || true)
BROWSER_SESSION_MODE=${BROWSER_SESSION_MODE:-persistent}
ENABLE_FULL_LOGIN=${ENABLE_FULL_LOGIN:-0}

cat > $APP/package.json <<'PKGEOF'
{
  "name": "bukeala-native-host-cloud",
  "version": "1.0.0",
  "description": "Bukeala session keeper con perfil persistente en GCE o Fly.io",
  "private": true,
  "scripts": {
    "start": "node watcher.js",
    "test": "node --test persistentSession.test.js test/persistentWatcher.test.js",
    "probe": "node persistentProbe.js"
  },
  "dependencies": {
    "playwright": "1.59.1",
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
// Load legacy plugins only when a legacy entry point is used. The persistent
// browser uses unmodified Playwright and the installed browser's actual UA.
let legacyChromium;
function getLegacyChromium() {
  if (!legacyChromium) {
    legacyChromium = require("playwright-extra").chromium;
    const StealthPlugin = require("puppeteer-extra-plugin-stealth");
    try { legacyChromium.use(StealthPlugin()); } catch { /* already applied */ }
  }
  return legacyChromium;
}

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const TWO_CAPTCHA_POLL_INTERVAL_MS = 5000;
const TWO_CAPTCHA_MAX_WAIT_MS = 120 * 1000;
const SESSION_WAIT_MS = 10000; // espera activa por el JSESSIONID de Bukeala

const BUKEALA_BASE = "https://appoint.tuscitasmedicas.com/keraltyadscritos";
const BUKEALA_HOME = `${BUKEALA_BASE}/findAvailability`;
// Endpoint autenticado y barato para PROBAR que la sesión de verdad sirve
// (el mismo que usa el Worker): con sesión muerta responde 302/403, no JSON.
const VERIFY_PATH = "/findAvailability/loadComponents?branchIdStr=456&attentionType=P&areaCode=&authorizationCode=";

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
  const subRes = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${submitParams}`, { signal: AbortSignal.timeout(20_000) });
  const subJson = await subRes.json();
  if (subJson.status !== 1) {
    // Saldo agotado u otro error fatal: propagar claro para abortar el ciclo.
    throw new Error(`2Captcha submit failed: ${subJson.request ?? "unknown"}`);
  }
  const captchaId = subJson.request;
  const startedAt = Date.now();
  while (Date.now() - startedAt < TWO_CAPTCHA_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, TWO_CAPTCHA_POLL_INTERVAL_MS));
    const pollRes = await fetch(`${TWO_CAPTCHA_BASE}/res.php?key=${twoCaptchaKey}&action=get&id=${captchaId}&json=1`, { signal: AbortSignal.timeout(20_000) });
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

/**
 * PRUEBA REAL de que la sesión sirve: llama un endpoint autenticado con las
 * cookies del contexto y exige 200 + JSON.
 *
 * Por qué existe: comprobar "la cookie JSESSIONID existe" + "la URL parece
 * autenticada" NO alcanza. El 29/jul (19:27-19:55 Bogotá) Bukeala invalidó la
 * sesión y el navegador vivo siguió navegando a /keraltyadscritos/findCustomer
 * sin ver el form de CAS → reportó "alive OK" y empujó una sesión MUERTA cada
 * 10 min durante ~28 min. /agenda caído todo ese rato sin que nadie lo supiera.
 * Con esta prueba, ese caso cae a login completo (~90 s) en el primer ciclo.
 */
async function verifySessionWorks(context, log, opts = {}) {
  try {
    const url = `${BUKEALA_BASE}${VERIFY_PATH}&_=${Date.now()}`;
    const res = await context.request.get(url, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: BUKEALA_HOME,
      },
      maxRedirects: 0,      // un 302 a login es fallo, no algo que seguir
      timeout: 20_000,
    });
    const status = res.status();
    if (status !== 200) {
      log("warn", "verificación de sesión falló", { status });
      return { ok: false, detail: `status ${status}`, status, authRequired: status === 401 || status === 403 || status === 302, retryable: status >= 500 };
    }
    const body = (await res.text().catch(() => "")).trim();
    // Con sesión viva loadComponents devuelve un array JSON.
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      log("warn", "verificación de sesión: respuesta no-JSON");
      return { ok: false, detail: "respuesta no-JSON", inconclusive: true };
    }
    if (opts.strict && !isComponentsResponse(parsed)) {
      log("warn", "verificación de sesión: estructura no reconocida");
      return { ok: false, detail: "estructura loadComponents no reconocida", inconclusive: true };
    }
    return { ok: true, detail: `200 (${body.length} bytes)` };
  } catch (e) {
    log("warn", "verificación de sesión lanzó", { error: e.message });
    return { ok: false, detail: e.message, retryable: true };
  }
}

/** Strict success shape for the authenticated loadComponents endpoint. */
function isComponentsResponse(value) {
  return Array.isArray(value) && value.length > 0 && value.every((row) =>
    row && typeof row === "object" && !Array.isArray(row) &&
    Number.isFinite(row.id) && typeof row.code === "string" && row.code.trim().length > 0 &&
    typeof row.description === "string"
  );
}

/**
 * Verificación AUTORITATIVA: le pregunta al WORKER si la sesión que acabamos
 * de empujar le sirve. El modo estricto consulta /debug/components y valida
 * el cuerpo real; el modo legacy conserva /debug/measure.
 *
 * Por qué no basta verifySessionWorks(): esa prueba usa las cookies del
 * NAVEGADOR, y el Worker solo recibe el subconjunto que captureAndPush filtra
 * (y de ese, cookieHeader manda las del dominio/path). Si falta una pieza —p.
 * ej. AWSALB, que fija el backend con la sesión Java— el navegador funciona y
 * el Worker recibe 302. Eso es lo que pasó el 29/jul: pushes de 14 cookies
 * "OK" con /agenda caído. Esta prueba mide justo lo que importa.
 */
async function verifyViaWorker(WORKER_URL, CAPTURE_TOKEN, log, opts = {}) {
  const base = WORKER_URL.replace(/\/capture$/, "");
  const resource = opts.strict ? "components" : "measure";
  const url = `${base}/debug/${resource}?token=${encodeURIComponent(CAPTURE_TOKEN)}`;

  // Un intento: distingue VEREDICTO ({alive:true/false}) de AMBIGUO (5xx, red,
  // cuerpo no-JSON). Solo un veredicto explícito de "no sirve" descarta la sesión.
  async function attempt() {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        ...(opts.strict ? { redirect: "manual" } : {}),
      });
      if (opts.strict) {
        const status = res.status;
        if (status !== 200) {
          return {
            verdict: status === 401 || status === 403 ? "malo" : "ambiguo",
            detail: `worker-components-http-${status}`, status,
          };
        }
        let components;
        try { components = JSON.parse(await res.text()); } catch {
          return { verdict: "malo", detail: "worker-components-invalid-json", status };
        }
        if (!isComponentsResponse(components)) {
          return { verdict: "malo", detail: "worker-components-invalid-shape", status };
        }
        return { verdict: "ok", detail: "worker-components-verified", status, componentCount: components.length };
      }
      if (!res.ok) return { verdict: "ambiguo", detail: `worker HTTP ${res.status}` };
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { return { verdict: "ambiguo", detail: "cuerpo no-JSON" }; }
      if (data.alive === true) return { verdict: "ok", detail: `worker status ${data.status}` };
      if (data.alive === false) {
        return {
          verdict: "malo",
          detail: `worker dice ${data.status ?? data.err ?? "no-alive"} (${data.cookies ?? "?"} cookies)`,
        };
      }
      return { verdict: "ambiguo", detail: "respuesta sin campo alive" };
    } catch (e) {
      return { verdict: "ambiguo", detail: opts.strict ? "worker-components-network-error" : e.message };
    }
  }

  let r = await attempt();
  if (r.verdict === "ambiguo") {
    // Reintento único: un hipo de red del Worker no debe costar un captcha.
    await new Promise((res) => setTimeout(res, 5000));
    r = await attempt();
  }

  if (r.verdict === "ok") return {
    ok: true, detail: r.detail,
    ...(opts.strict ? { status: r.status, componentCount: r.componentCount } : {}),
  };
  if (r.verdict === "malo") {
    log("warn", "verify via worker: el Worker NO puede usar la sesión", { detail: r.detail });
    return { ok: false, detail: r.detail, ...(opts.strict ? { status: r.status } : {}) };
  }
  if (opts.strict) {
    log("warn", "verify via worker inconcluso tras reintento");
    return { ok: false, inconclusive: true, retryable: true, detail: "worker-verification-inconclusive" };
  }
  // AMBIGUO tras reintento: asumir OK. verifySessionWorks() ya validó la sesión
  // contra Bukeala desde el navegador; tirar el navegador vivo por no poder
  // hablar con el Worker gastaría un captcha por nada (y en cadena).
  log("warn", "verify via worker inconcluso tras reintento → se asume OK", { detail: r.detail });
  return { ok: true, detail: `inconcluso: ${r.detail}` };
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
    signal: AbortSignal.timeout(20_000),
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
    // savedAt: para poder comparar con el TGC del Worker y usar el MÁS RECIENTE
    // (21-sep-2026: un archivo de 5 días ganaba siempre sobre uno fresco).
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies: tgc, origins: [], savedAt: new Date().toISOString() }));
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
      // `at`: cuándo se guardó. Archivos viejos (sin savedAt) usan la fecha del fichero.
      const at = raw.savedAt || fs.statSync(file).mtime.toISOString();
      if (tgc.length) return { cookies: tgc, origins: [], at, file };
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
    return { cookies: data.cookies, origins: [], at: data.capturedAt || null };
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

  const browser = await getLegacyChromium().launch({
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
    // Se miran AMBAS fuentes y gana el TGC MÁS RECIENTE. Antes el archivo local
    // ganaba siempre que existiera, y el 21-sep-2026 uno de 5 días (muerto)
    // tapó el que el Dr. acababa de sembrar desde Brave: formulario CAS →
    // captcha → Radware, en bucle. El del Worker es el último login HUMANO,
    // que es el que importa desde que Radware bloquea el login automático.
    const fromFile = loadTgc(STATE_FILE);
    const fromWorker = await fetchTgcFromWorker(WORKER_URL, CAPTURE_TOKEN, log);
    const ms = (t) => (t && t.at ? Date.parse(t.at) || 0 : 0);
    let savedTgc = null;
    if (fromFile && fromWorker) {
      savedTgc = ms(fromWorker) > ms(fromFile) ? fromWorker : fromFile;
      diag.tgcSource = savedTgc === fromWorker ? "worker" : "file";
      log("info", "TGC: elegido el más reciente", { file: fromFile.at, worker: fromWorker.at, elegido: diag.tgcSource });
    } else if (fromFile || fromWorker) {
      savedTgc = fromFile || fromWorker;
      diag.tgcSource = fromFile ? "file" : "worker";
    } else {
      diag.tgcSource = null;
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
      // Si CAS mostró el formulario, el TGC que presentamos está MUERTO. Si
      // venía del archivo local, borrarlo: si no, en el siguiente ciclo vuelve a
      // ganar y tapa cualquier TGC fresco que el Dr. siembre desde Brave.
      if (nav1.usedCaptcha && diag.tgcSource === "file") {
        try { fs.unlinkSync(STATE_FILE); log("info", "TGC del archivo rechazado por CAS → archivo borrado"); }
        catch { /* ya no existía */ }
      }
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

    // Probar que la sesión SIRVE (no solo que la cookie existe) antes de
    // empujarla al Worker. Si el TGC dio una sesión inútil, caer al fallback
    // con captcha en vez de publicar algo muerto.
    const verify = await verifySessionWorks(activeCtx, log);
    if (!verify.ok) {
      if (diag.via === "tgc") {
        log("warn", "TGC dio sesión inválida → fallback contexto fresco", { detail: verify.detail });
        diag.fellBack = true;
        diag.via = "captcha-fallback";
        await ctx1.close().catch(() => {});
        const ctx3 = await browser.newContext({ ...CONTEXT_OPTIONS });
        const page3 = await ctx3.newPage();
        await navigateAndLogin(page3, creds, TWO_CAPTCHA_API_KEY, log);
        await waitForBukealaSession(ctx3, SESSION_WAIT_MS);
        activeCtx = ctx3;
        activePage = page3;
        diag.hadBukealaJsession = (await hasBukealaSession(ctx3)) && looksAuthenticated(page3.url());
        const verify2 = await verifySessionWorks(activeCtx, log);
        if (!verify2.ok) throw new Error(`sesión inválida incluso tras captcha (${verify2.detail})`);
      } else {
        throw new Error(`sesión inválida tras login con captcha (${verify.detail})`);
      }
    }

    let cookieCount = await captureAndPush(activeCtx, WORKER_URL, CAPTURE_TOKEN, log);

    // Comprobación FINAL con el Worker. Si el push no le sirve y veníamos por
    // TGC, reintentar con contexto fresco + captcha (login probado).
    let wv = await verifyViaWorker(WORKER_URL, CAPTURE_TOKEN, log);
    if (!wv.ok && diag.via === "tgc") {
      log("warn", "push por TGC inservible para el Worker → fallback captcha", { detail: wv.detail });
      diag.fellBack = true;
      diag.via = "captcha-fallback";
      await ctx1.close().catch(() => {});
      const ctx4 = await browser.newContext({ ...CONTEXT_OPTIONS });
      const page4 = await ctx4.newPage();
      await navigateAndLogin(page4, creds, TWO_CAPTCHA_API_KEY, log);
      await waitForBukealaSession(ctx4, SESSION_WAIT_MS);
      activeCtx = ctx4;
      activePage = page4;
      diag.hadBukealaJsession = (await hasBukealaSession(ctx4)) && looksAuthenticated(page4.url());
      cookieCount = await captureAndPush(activeCtx, WORKER_URL, CAPTURE_TOKEN, log);
      wv = await verifyViaWorker(WORKER_URL, CAPTURE_TOKEN, log);
    }
    if (!wv.ok) throw new Error(`el Worker no puede usar la sesión (${wv.detail})`);

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

    // CRÍTICO: probar que la sesión SIRVE antes de empujarla. Sin esto se
    // empujaban sesiones muertas reportadas como buenas (ver verifySessionWorks).
    const verify = await verifySessionWorks(context, log);
    if (!verify.ok) {
      return {
        ok: false, needsFullLogin: true,
        reason: `sesión no válida en sitio (${verify.detail})`, postNavUrl,
      };
    }

    const cookieCount = await captureAndPush(context, WORKER_URL, CAPTURE_TOKEN, log);

    // Comprobación FINAL con el Worker: ¿de verdad puede usar lo que empujamos?
    // Si no, esta sesión de navegador ya no sirve → login completo.
    const wv = await verifyViaWorker(WORKER_URL, CAPTURE_TOKEN, log);
    if (!wv.ok) {
      return {
        ok: false, needsFullLogin: true,
        reason: `push inservible para el Worker (${wv.detail})`, postNavUrl,
      };
    }

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

/**
 * ADOPTAR la sesión que sembró el navegador del Dr., sin loguearse jamás.
 *
 * POR QUÉ (21-sep-2026): Radware bloquea el login automático de la VM — 12
 * intentos, 0 éxitos, el último con un TGC creado minutos antes por un login
 * humano. El TGC NO es adoptable para loguear desde la VM. Pero el JSESSIONID
 * de Bukeala SÍ es portable a otra IP: el Worker lo usa desde Cloudflare y
 * funciona, y `appoint.tuscitasmedicas.com` no tiene Radware (HAR de 263
 * peticiones, 0 rastro). Así que cargamos esas cookies en Playwright y, si la
 * sesión responde autenticada, se convierte en la `liveSession` que
 * `keepAliveInPlace` mantiene viva navegando. Cero captchas.
 *
 * Devuelve { ok:true, browser, context, page, cookieCount } o { ok:false, reason }.
 */
async function adoptSession(env) {
  const { CAPTURE_TOKEN, WORKER_URL, log } = env;
  let browser = null;
  try {
    const base = WORKER_URL.replace(/\/capture$/, "");
    const res = await fetch(`${base}/native-host/session`, {
      headers: { "X-Capture-Token": CAPTURE_TOKEN },
    });
    if (!res.ok) return { ok: false, reason: `worker respondió ${res.status}` };
    const data = await res.json();
    if (!data.found || !Array.isArray(data.cookies) || data.cookies.length === 0) {
      // Caso normal cuando el Dr. tiene el navegador cerrado y la sesión ya venció.
      return { ok: false, reason: `sin sesión que adoptar: ${data.reason || "worker sin sesión"}` };
    }
    log("info", "sesión recibida del Worker", { cookies: data.cookies.length, edadMin: data.edadMin });

    browser = await getLegacyChromium().launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ ...CONTEXT_OPTIONS });
    await context.addCookies(data.cookies.map(toPlaywrightCookie));
    const page = await context.newPage();

    // La prueba real: navegar y comprobar que Bukeala nos trata como
    // autenticados. Si CAS nos manda al formulario, la sesión no sirve — y NO
    // se loguea: se reporta y se espera a que el Dr. siembre una nueva.
    await page.goto(BUKEALA_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    const url = page.url();
    if (url.includes("/cas/login")) {
      await browser.close().catch(() => {});
      return { ok: false, reason: `la sesión adoptada no sirve (CAS pidió login, url=${url})` };
    }
    await waitForBukealaSession(context, SESSION_WAIT_MS);
    const authed = (await hasBukealaSession(context)) && looksAuthenticated(url);
    if (!authed) {
      await browser.close().catch(() => {});
      return { ok: false, reason: `adoptada pero sin sesión de Bukeala (url=${page.url()})` };
    }

    const cookieCount = await captureAndPush(context, WORKER_URL, CAPTURE_TOKEN, log);
    log("info", "sesión ADOPTADA (sin login, sin captcha)", { url: page.url(), cookieCount });
    return { ok: true, browser, context, page, cookieCount, postNavUrl: page.url() };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, reason: `adopción falló: ${e.message}` };
  }
}

module.exports = {
  runAutoLogin, keepAliveInPlace, adoptSession,
  sessionHelpers: {
    BUKEALA_HOME, hasBukealaSession, submitCasForm, verifySessionWorks,
    captureAndPush, verifyViaWorker, isComponentsResponse,
  },
};

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
const { runAutoLogin, keepAliveInPlace, adoptSession } = require("./autoLogin");

const APP_DIR = os.tmpdir(); // solo para screenshots de error
// Archivo del TGC de CAS entre renovaciones → la mayoría no usan captcha.
// Vive en el HOME (persiste reboots — /tmp se borraba al reiniciar la VM y
// cada reboot costaba un captcha). Solo guarda la cookie TGC, no el estado
// completo (el estado completo envenenaba la sesión — lección jun 2026).
// Radware bloquea el login automatico desde la VM (21-sep-2026: 12 intentos,
// 0 exitos, incluso con TGC recien creado por un login humano). Cada intento
// gasta un captcha para nada, asi que por DEFECTO la VM no loguea: solo ADOPTA
// la sesion que siembra el navegador del Dr. Poner DISABLE_AUTO_LOGIN=0 para
// reactivar el login (si algun dia Colsanitas cambia).
const DISABLE_AUTO_LOGIN = process.env.DISABLE_AUTO_LOGIN !== "0";

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

    // 2. ADOPTAR la sesion del navegador del Dr. (sin loguear, sin captcha).
    //    Es el camino normal desde que Radware bloquea el login de la VM.
    const ad = await adoptSession(c);
    if (ad.ok) {
      adoptLiveSession({ browser: ad.browser, context: ad.context, page: ad.page });
      const durationMs = Date.now() - startedAt;
      log("info", "auto-login OK", { cookieCount: ad.cookieCount, durationMs, reason, via: "adoptada", url: ad.postNavUrl });
      await reportEvent(c, {
        type: "ok", message: `${ad.cookieCount} cookies (cloud, ${reason}, adoptada)`,
        cookieCount: ad.cookieCount, durationMs, via: "adoptada",
        hadBukealaJsession: true, postNavUrl: ad.postNavUrl,
        aliveFail: aliveFail || undefined,
      });
      return { ok: true, via: "adoptada", cookieCount: ad.cookieCount, postNavUrl: ad.postNavUrl };
    }

    // 3. No hubo nada que adoptar. NO se loguea (gastaria captcha y Radware lo
    //    bloquea): se reporta y se espera a que el Dr. siembre sesion.
    if (DISABLE_AUTO_LOGIN) {
      const durationMs = Date.now() - startedAt;
      log("warn", "sin sesion que adoptar — el Dr. debe loguearse en su navegador", { reason: ad.reason });
      await reportEvent(c, {
        type: "error",
        message: `${ad.reason} (cloud, ${reason}, via=adopcion; login automatico DESACTIVADO)`,
        durationMs, via: "adoptada", aliveFail: aliveFail || undefined,
      });
      return { ok: false, reason: ad.reason, via: "adoptada" };
    }

    // 4. Login completo (solo con DISABLE_AUTO_LOGIN=0).
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
  // perfdrive/botmanager = anti-bot Radware (Colsanitas, ago 2026): el login
  // automático NO pasa y reintentarlo solo entrena su modelo contra la cuenta.
  // Tratarlo como fatal → backoff largo (15/30/60 min) en vez de martillar
  // cada 90s. Se resuelve cuando el Dr. re-siembra la sesión desde su Chrome
  // (login humano) y el navegador vivo la renueva en sitio, sin login.
  const FATAL_PATTERNS = [/ZERO_BALANCE/i, /perfdrive/i, /botmanager/i, /no produjo sesión de Bukeala/i];

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

const start = process.env.BROWSER_SESSION_MODE === "persistent"
  ? () => require("./persistentWatcher").main()
  : main;

start().catch(() => {
  log("error", "fatal", { mode: process.env.BROWSER_SESSION_MODE || "legacy" });
  process.exit(2);
});

WEOF

cat > "$APP/persistentSession.js" <<'MODULEEOF'
/**
 * One persistent Chromium profile, including CAS/browser state across restarts.
 * No legacy cookie import, profile reset, UA override, or stealth plugin.
 *
 * Full login requires ENABLE_FULL_LOGIN=1. A failed attempt has a durable
 * cooldown (at least 30 minutes), including after process restarts.
 * publish:false verifies in the browser without writing to the Worker.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { sessionHelpers } = require("./autoLogin");

const CAS_ENTRY = "https://app01.colsanitas.com/cas/login?service=" +
  encodeURIComponent("https://appoint.tuscitasmedicas.com/keraltyadscritos/cas/login");
const MIN_LOGIN_COOLDOWN_MS = 30 * 60 * 1000;
const SAFE_PATHS = new Set(["/", "/cas/login", "/authentication/login",
  "/keraltyadscritos/cas/login", "/keraltyadscritos/findAvailability"]);

function safeLocation(value) {
  try {
    const url = new URL(value);
    return url.origin + (SAFE_PATHS.has(url.pathname) ? url.pathname : "/[redacted]");
  } catch { return null; }
}

function isCasFormLocation(value) {
  try {
    const url = new URL(value);
    return url.hostname === "app01.colsanitas.com" && url.pathname === "/cas/login";
  } catch { return false; }
}

function isAuthChallenge(value) {
  try {
    const host = new URL(value).hostname;
    return host !== "appoint.tuscitasmedicas.com" && host !== "app01.colsanitas.com";
  } catch { return true; }
}

function relevantDomain(value) {
  const domain = String(value || "").toLowerCase().replace(/^\./, "");
  return domain === "tuscitasmedicas.com" || domain.endsWith(".tuscitasmedicas.com") ||
    domain === "colsanitas.com" || domain.endsWith(".colsanitas.com");
}

function prepareProfile(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-profile-directory");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function createPersistentSessionManager(env, options = {}) {
  const profileDir = path.resolve(env.BROWSER_PROFILE_DIR || path.join(os.homedir(), ".bukeala-browser"));
  const stateFile = path.join(profileDir, "session-keeper.json");
  const publish = options.publish !== false;
  const helpers = { ...sessionHelpers, ...options.helpers };
  const now = options.now || Date.now;
  // Inyectable para que las pruebas de adopción no toquen la red.
  const fetchImpl = options.fetch || ((...args) => globalThis.fetch(...args));
  const configuredCooldown = Number(env.FULL_LOGIN_COOLDOWN_MS);
  const cooldownMs = Number.isFinite(configuredCooldown)
    ? Math.max(MIN_LOGIN_COOLDOWN_MS, configuredCooldown) : MIN_LOGIN_COOLDOWN_MS;
  let context = null;
  let page = null;
  let inFlight = false;
  let closed = false;
  let seeded = false;
  let state;

  // Messages/metadata from legacy helpers may contain full URLs or server
  // bodies. Forward only fixed messages and numeric diagnostics.
  function log(level, event, metadata = {}) {
    if (typeof env.log !== "function") return;
    const safe = {};
    for (const key of ["status", "elapsedMs", "cookieCount", "count"]) {
      if (typeof metadata[key] === "number") safe[key] = metadata[key];
    }
    env.log(level, event, safe);
  }
  function helperLog(level, _message, metadata) {
    log(level, "persistent-session helper diagnostic", metadata);
  }

  function readState() {
    if (state) return state;
    prepareProfile(profileDir);
    if (!fs.existsSync(stateFile)) return (state = {});
    if (fs.lstatSync(stateFile).isSymbolicLink()) throw new Error("unsafe-profile-state");
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-profile-state");
    for (const key of ["lastFullLoginAttemptAt", "lastFullLoginSuccessAt", "seededAt"]) {
      if (parsed[key] !== undefined && (!Number.isFinite(parsed[key]) || parsed[key] < 0)) {
        throw new Error("invalid-profile-state");
      }
    }
    return (state = parsed);
  }

  function saveState() {
    prepareProfile(profileDir);
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, stateFile);
  }

  async function ensureContext() {
    if (closed) throw new Error("manager-closed");
    readState();
    if (context) {
      if (!page || page.isClosed()) page = await context.newPage();
      return;
    }
    const chromium = options.chromium || require("playwright").chromium;
    const headless = options.headless === undefined ? env.BROWSER_HEADLESS !== "0" : options.headless !== false;
    const launched = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: headless ? { width: 1366, height: 800 } : null,
      locale: "es-CO",
      timezoneId: "America/Bogota",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--restore-last-session",
        ...(!headless ? ["--start-maximized"] : [])],
      timeout: 60_000,
    });
    context = launched;
    context.on("close", () => {
      if (context === launched) { context = null; page = null; }
    });
    page = context.pages().find(candidate => !candidate.isClosed()) || await context.newPage();
    log("info", "persistent browser profile opened");
  }

  function result(overrides = {}) {
    return {
      ok: false, via: seeded ? "persistent-adopted" : "persistent",
      authenticated: false, published: false, captureAccepted: false,
      workerVerified: false, loginAttempted: false, needsFullLogin: false,
      retryable: false, authBlocked: false,
      postNavUrl: page && !page.isClosed() ? safeLocation(page.url()) : null,
      ...overrides,
    };
  }

  async function navigate(target) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
  }

  async function renew(renewOptions = {}) {
    if (inFlight) return result({ reasonCode: "busy", reason: "persistent-operation-in-progress", retryable: true });
    inFlight = true;
    let authenticated = false;
    let loginAttempted = false;
    let captureAccepted = false;
    let stage = "profile";
    try {
      await ensureContext();
      stage = "navigation";
      await navigate(helpers.BUKEALA_HOME);
      if (isAuthChallenge(page.url())) {
        return result({ reasonCode: "auth-challenge", reason: "authentication-challenge", authBlocked: true });
      }

      stage = "verification";
      let verification = isCasFormLocation(page.url()) ? { ok: false, authRequired: true }
        : await helpers.verifySessionWorks(context, helperLog, { strict: true });
      // Only an explicit authentication rejection can initiate CAS renewal.
      // A timeout, invalid JSON or server error preserves the current context.
      if (!verification.ok && verification.authRequired && !isCasFormLocation(page.url())) {
        stage = "navigation";
        await navigate(CAS_ENTRY);
        if (isAuthChallenge(page.url())) {
          return result({ reasonCode: "auth-challenge", reason: "authentication-challenge", authBlocked: true });
        }
        stage = "verification";
        verification = isCasFormLocation(page.url()) ? { ok: false, authRequired: true }
          : await helpers.verifySessionWorks(context, helperLog, { strict: true });
      }

      // Antes de pensar en un login completo (que el anti-bot rechaza), heredar
      // la sesión que el Dr. ya sembró desde su navegador. Este es el camino de
      // recuperación automática: el humano se loguea UNA vez y la VM la adopta
      // sola, sin credenciales ni captcha. Sin esto, una sesión muerta dejaba a
      // la VM sin salida (caída del 24-25/oct/2026).
      if (!verification.ok && verification.authRequired) {
        stage = "adoption";
        const adopted = await adoptWorkerSession();
        log("info", "persistent-session adoption attempt", { cookieCount: adopted.cookieCount });
        if (adopted.ok) {
          stage = "navigation";
          await navigate(helpers.BUKEALA_HOME);
          if (isAuthChallenge(page.url())) {
            return result({ reasonCode: "auth-challenge", reason: "authentication-challenge", authBlocked: true });
          }
          stage = "verification";
          verification = isCasFormLocation(page.url()) ? { ok: false, authRequired: true }
            : await helpers.verifySessionWorks(context, helperLog, { strict: true });
        }
      }

      if (!verification.ok && isCasFormLocation(page.url())) {
        const visibleForm = await Promise.all([
          page.locator('input[name="username"], input#username').first().waitFor({ state: "visible", timeout: 10000 }),
          page.locator('input[name="password"], input#password').first().waitFor({ state: "visible", timeout: 10000 }),
        ]).then(() => true, () => false);
        if (!visibleForm) {
          return result({ reasonCode: "login-form-unavailable", reason: "login-form-unavailable", authBlocked: true });
        }
        if (env.ENABLE_FULL_LOGIN !== "1" || renewOptions.allowFullLogin === false) {
          return result({ reasonCode: "full-login-disabled", reason: "full-login-disabled", needsFullLogin: true });
        }
        if (!env.CAS_USERNAME || !env.CAS_PASSWORD || !env.TWO_CAPTCHA_API_KEY) {
          return result({ reasonCode: "login-config-missing", reason: "login-config-missing", needsFullLogin: true });
        }
        const lastAttempt = state.lastFullLoginAttemptAt || 0;
        const lastSuccess = state.lastFullLoginSuccessAt || 0;
        if (lastAttempt > lastSuccess && now() - lastAttempt < cooldownMs) {
          return result({
            reasonCode: "full-login-cooldown", reason: "full-login-cooldown",
            needsFullLogin: true, retryable: true,
            nextLoginAt: new Date(lastAttempt + cooldownMs).toISOString(),
          });
        }
        // Persist before submission, so a crash cannot reset the attempt limit.
        state.lastFullLoginAttemptAt = now();
        state.lastFullLoginSuccessAt = 0;
        saveState();
        loginAttempted = true;
        stage = "full-login";
        await helpers.submitCasForm(page, {
          username: env.CAS_USERNAME, password: env.CAS_PASSWORD,
        }, env.TWO_CAPTCHA_API_KEY, helperLog);
        if (isAuthChallenge(page.url()) || isCasFormLocation(page.url())) {
          return result({
            via: "persistent-login", loginAttempted, needsFullLogin: true,
            reasonCode: "full-login-rejected", reason: "full-login-rejected", authBlocked: true,
          });
        }
        stage = "verification";
        verification = await helpers.verifySessionWorks(context, helperLog, { strict: true });
      }

      if (!verification.ok || !(await helpers.hasBukealaSession(context))) {
        return result({
          loginAttempted, via: loginAttempted ? "persistent-login" : result().via,
          reasonCode: "browser-verification-failed", reason: "browser-verification-failed",
          needsFullLogin: !!verification.authRequired, retryable: !verification.authRequired,
        });
      }
      authenticated = true;
      state.validated = true;
      if (loginAttempted) state.lastFullLoginSuccessAt = now();
      saveState();
      const via = loginAttempted ? "persistent-login" : result().via;
      if (!publish) {
        const cookieCount = (await context.cookies()).filter(cookie => relevantDomain(cookie.domain)).length;
        return result({ ok: true, via, authenticated, loginAttempted, cookieCount });
      }
      if (!env.WORKER_URL || !env.CAPTURE_TOKEN) {
        return result({ via, authenticated, loginAttempted, reasonCode: "publish-config-missing", reason: "publish-config-missing" });
      }
      stage = "publication";
      const cookieCount = await helpers.captureAndPush(context, env.WORKER_URL, env.CAPTURE_TOKEN, helperLog);
      captureAccepted = true;
      const worker = await helpers.verifyViaWorker(env.WORKER_URL, env.CAPTURE_TOKEN, helperLog, { strict: true });
      if (!worker.ok) {
        return result({
          via, authenticated, loginAttempted, captureAccepted, cookieCount, retryable: true,
          reasonCode: worker.inconclusive ? "worker-verification-inconclusive" : "worker-verification-failed",
          reason: worker.inconclusive ? "worker-verification-inconclusive" : "worker-verification-failed",
        });
      }
      return result({
        ok: true, via, authenticated, loginAttempted, captureAccepted,
        published: true, workerVerified: true, cookieCount,
      });
    } catch (error) {
      // Do not return browser errors: they can embed login URLs, submitted
      // credential values, cookies, or server bodies. Fixed codes suffice.
      const reasonCode = `${stage}-failed`;
      log("warn", "persistent session operation failed");
      return result({
        authenticated, loginAttempted, captureAccepted,
        via: loginAttempted ? "persistent-login" : result().via,
        reasonCode, reason: reasonCode, retryable: stage !== "full-login",
        needsFullLogin: stage === "full-login", authBlocked: stage === "full-login",
      });
    } finally {
      inFlight = false;
    }
  }

  /**
   * Explicit one-time migration only. Never called by renew(). Refuses to
   * overwrite any existing relevant cookies or a previously validated profile.
   * Caller must obtain an authorized fresh snapshot and then call renew().
   */
  /**
   * Núcleo de la siembra de cookies. NO toca `inFlight` a propósito: lo llaman
   * tanto `seedCookies` (migración manual, que sí lo toma) como
   * `adoptWorkerSession` desde dentro de `renew()`, que ya lo tiene tomado —
   * si lo tomara otra vez, la adopción se auto-respondería "busy".
   *
   * `replace` distingue los dos usos: la migración manual solo siembra en un
   * perfil virgen, mientras que la recuperación automática DEBE poder pisar una
   * sesión muerta con la nueva que sembró el humano.
   */
  async function applyCookieSnapshot(cookies, capturedAt, { replace = false } = {}) {
    await ensureContext();
    const timestamp = Date.parse(capturedAt);
    if (!Number.isFinite(timestamp) || timestamp > now() + 60_000 || now() - timestamp > 30 * 60_000) {
      return result({ reasonCode: "seed-not-fresh", reason: "seed-not-fresh" });
    }
    if (!replace &&
        (state.validated || state.seededAt || (await context.cookies()).some(cookie => relevantDomain(cookie.domain)))) {
      return result({ reasonCode: "profile-already-populated", reason: "profile-already-populated" });
    }
    // En recuperación, no re-sembrar la MISMA captura una y otra vez: si el Dr.
    // no ha vuelto a loguearse, la foto es la misma y volvería a fallar igual.
    if (replace && Number.isFinite(state.seededAt) && state.seededAt > 0 && timestamp <= state.seededAt) {
      return result({ reasonCode: "seed-not-newer", reason: "seed-not-newer" });
    }
    if (!Array.isArray(cookies) || !cookies.length) return result({ reasonCode: "seed-empty", reason: "seed-empty" });
    const filtered = cookies.filter(cookie =>
        cookie && relevantDomain(cookie.domain) && typeof cookie.name === "string" &&
        typeof cookie.value === "string" && cookie.value.length > 0 &&
        (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now() / 1000) &&
        !(cookie.name === "JSESSIONID" && !String(cookie.domain).includes("tuscitasmedicas.com"))
      ).map(cookie => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain,
        path: cookie.path || "/", httpOnly: !!cookie.httpOnly, secure: cookie.secure !== false,
        ...(typeof cookie.expires === "number" && cookie.expires > 0 ? { expires: cookie.expires } : {}),
        ...(["Strict", "Lax", "None"].includes(cookie.sameSite) ? { sameSite: cookie.sameSite } : {}),
      }));
    if (!filtered.some(cookie => cookie.name === "JSESSIONID")) {
      return result({ reasonCode: "seed-no-bukeala-session", reason: "seed-no-bukeala-session" });
    }
    if (replace) {
      // Quitar primero las cookies vivas del portal: si queda una JSESSIONID
      // muerta en el mismo dominio y path, addCookies no garantiza cuál gana.
      for (const cookie of (await context.cookies()).filter(entry => relevantDomain(entry.domain))) {
        await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
      }
      state.validated = false;
    }
    state.seededAt = timestamp;
    saveState();
    await context.addCookies(filtered);
    seeded = true;
    return result({ ok: true, seeded: true, cookieCount: filtered.length });
  }

  async function seedCookies(cookies, { capturedAt } = {}) {
    if (inFlight) return result({ reasonCode: "busy", reason: "persistent-operation-in-progress" });
    inFlight = true;
    try {
      return await applyCookieSnapshot(cookies, capturedAt, { replace: false });
    } catch {
      return result({ reasonCode: "seed-failed", reason: "seed-failed" });
    } finally { inFlight = false; }
  }

  /**
   * Adopta la sesión que el Dr. capturó con la extensión de su navegador.
   *
   * POR QUÉ EXISTE: el login completo automatizado lo rechaza el anti-bot del
   * portal, así que cuando la sesión del perfil muere el único camino legítimo
   * es heredar la que sembró un humano. Eso solo existía como migración manual
   * (`persistentProbe --seed-worker`), de modo que una sesión muerta dejaba a la
   * VM sin salida automática: fue la causa de la caída del 24-25/oct/2026, dos
   * días enteros sin una sola renovación exitosa.
   */
  async function adoptWorkerSession() {
    const base = String(env.WORKER_URL || "").replace(/\/capture\/?$/, "");
    if (!base || !env.CAPTURE_TOKEN) {
      return result({ reasonCode: "adopt-config-missing", reason: "adopt-config-missing" });
    }
    let snapshot;
    try {
      const response = await fetchImpl(`${base}/native-host/session`, {
        headers: { "X-Capture-Token": env.CAPTURE_TOKEN },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return result({ reasonCode: "adopt-fetch-failed", reason: "adopt-fetch-failed", retryable: true });
      }
      snapshot = await response.json();
    } catch {
      return result({ reasonCode: "adopt-fetch-failed", reason: "adopt-fetch-failed", retryable: true });
    }
    try {
      return await applyCookieSnapshot(snapshot?.cookies, snapshot?.capturedAt, { replace: true });
    } catch {
      return result({ reasonCode: "adopt-failed", reason: "adopt-failed" });
    }
  }

  async function close() {
    if (inFlight) throw new Error("persistent-operation-in-progress");
    closed = true;
    const active = context;
    context = null;
    page = null;
    if (active) await active.close();
  }

  // Available only to the explicit, non-publishing probe. This simulates
  // losing local auth cookies; it never logs out CAS/server-side.
  async function simulateAppSessionLoss({ includeSso = false } = {}) {
    if (publish || options.expiryProbe !== true) throw new Error("probe-only-operation");
    if (inFlight) throw new Error("persistent-operation-in-progress");
    inFlight = true;
    try {
      await ensureContext();
      if (!state.validated) throw new Error("probe-requires-validated-session");
      const cookies = await context.cookies();
      const sessions = cookies.filter(cookie => cookie.name === "JSESSIONID" &&
        /(^|\.)tuscitasmedicas\.com$/i.test(cookie.domain.replace(/^\./, "")));
      if (!sessions.length) throw new Error("probe-session-missing");
      const sso = includeSso ? cookies.filter(cookie =>
        /(^|\.)colsanitas\.com$/i.test(cookie.domain.replace(/^\./, "")) &&
        (cookie.name === "JSESSIONID" || /^(?:TGC|CASTGC)/i.test(cookie.name))) : [];
      if (includeSso && !sso.some(cookie => /^(?:TGC|CASTGC)/i.test(cookie.name))) {
        throw new Error("probe-sso-session-missing");
      }
      for (const cookie of [...sessions, ...sso]) {
        await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
      }
      return { removedSessionCookies: sessions.length, ...(includeSso ? { removedSsoCookies: sso.length } : {}) };
    } finally { inFlight = false; }
  }

  return {
    renew, seedCookies, close, profileDir,
    ...(!publish && options.expiryProbe === true ? { simulateAppSessionLoss } : {}),
  };
}

module.exports = { createPersistentSessionManager, safeLocation };

MODULEEOF

cat > "$APP/persistentWatcher.js" <<'MODULEEOF'
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: sleep } = require("node:timers/promises");

function numberOption(value, fallback, minimum) {
  const n = Number(value);
  return Number.isFinite(n) && n >= minimum ? n : fallback;
}

function safeResult(result) {
  return {
    ok: result?.ok === true,
    authenticated: result?.authenticated === true,
    published: result?.published === true,
    workerVerified: result?.workerVerified === true,
    loginAttempted: result?.loginAttempted === true,
    via: result?.via || "persistent",
    reasonCode: result?.reasonCode || null,
    // La URL (ya redactada por safeLocation en persistentSession) es el ÚNICO
    // dato que distingue un bloqueo del anti-bot de un redirect legítimo a un
    // host nuevo del portal. Se perdía aquí: el 24-25/oct/2026 hubo 101
    // "auth-challenge" sin saber a dónde nos desviaban, y la alerta de Telegram
    // del Worker (que busca "perfdrive") quedó muda por falta de este campo.
    postNavUrl: result?.postNavUrl || null,
  };
}

function createPersistentWatcher(env, options = {}) {
  if (!env.WORKER_URL || !env.CAPTURE_TOKEN) throw new Error("WORKER_URL y CAPTURE_TOKEN son obligatorios");
  const base = new URL(env.WORKER_URL);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("WORKER_URL debe ser HTTPS");
  base.pathname = base.pathname.replace(/\/capture\/?$/, "").replace(/\/$/, "");
  base.search = "";
  base.hash = "";
  const profileDir = env.BROWSER_PROFILE_DIR || path.join(os.homedir(), ".bukeala-browser");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const statusFile = path.join(profileDir, "watcher-status.json");
  const manager = options.manager || require("./persistentSession").createPersistentSessionManager(env);
  const fetchImpl = options.fetch || fetch;
  const now = options.now || Date.now;
  const logger = options.log || ((level, message, meta = {}) =>
    console.log(JSON.stringify({ ts: new Date(now()).toISOString(), level, message, ...meta })));
  const intervalMs = numberOption(env.PROACTIVE_INTERVAL_MS, 600000, 60000);
  const pollMs = numberOption(env.POLL_INTERVAL_MS, 30000, 1000);
  let status = { version: 1, successfulCycles: 0, fullLogins: 0, failures: 0, nextAttemptAt: 0 };
  try {
    const previous = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    if (previous.version === 1) status = { ...status, ...previous };
  } catch { /* First boot or interrupted status file: profile itself remains authoritative. */ }
  status.startedAt = new Date(now()).toISOString();
  let inFlight = false;
  let closed = false;
  let reportingCompletion = false;

  function persist() {
    const temp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(status, null, 2), { mode: 0o600 });
    fs.renameSync(temp, statusFile);
  }

  async function request(route, body) {
    const response = await fetchImpl(`${base.href.replace(/\/$/, "")}${route}`, {
      method: body ? "POST" : "GET",
      headers: { "X-Capture-Token": env.CAPTURE_TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  }

  async function report(route, body) {
    try { await request(route, body); }
    catch { logger("warn", "telemetría no disponible", { route }); }
  }

  async function flushCompletion() {
    const completion = status.completionOutbox;
    if (!completion || reportingCompletion || now() < (status.completionRetryAt || 0)) return;
    reportingCompletion = true;
    try {
      // Keep the result across restarts/network failures. A stale result is
      // acknowledged by the Worker without changing a different request.
      const acknowledgement = await request("/native-host/refresh-complete", completion);
      if (acknowledgement?.ok !== true) throw new Error("completion-not-acknowledged");
      if (status.completionOutbox === completion) {
        delete status.completionOutbox;
        delete status.completionRetryAt;
        persist();
      }
    } catch {
      status.completionRetryAt = now() + pollMs;
      persist();
      logger("warn", "confirmación de renovación pendiente");
    } finally {
      reportingCompletion = false;
    }
  }

  function retryMs(result) {
    // The session manager also persists its full-login cooldown across restarts.
    if (/captcha|blocked|credential|login|cooldown|challenge|config/i.test(result.reasonCode || "")) {
      return Math.min(3600000, 1800000 * Math.max(1, status.failures));
    }
    return Math.min(600000, 90000 * Math.max(1, status.failures));
  }

  async function runCycle(reason = "scheduled") {
    if (closed || inFlight) return { skipped: true, reason: "busy" };
    // A new process must reopen a healthy profile immediately, even if it
    // stopped during the previous success's short polling throttle. Failed
    // cycles retain their durable retry deadline, including on startup.
    const resumeHealthyProfile = reason === "startup" && status.failures === 0;
    if (now() < status.nextAttemptAt && !resumeHealthyProfile) return { skipped: true, reason: "backoff" };
    inFlight = true;
    const completionRequest = status.pendingRequest || status.completionOutbox?.requestedAt;
    status.lastAttemptAt = new Date(now()).toISOString();
    let result;
    try {
      result = await manager.renew();
    } catch {
      result = { ok: false, authenticated: false, reasonCode: "cycle_exception" };
    }
    try {
      const summary = safeResult(result);
      // A browser that works alone is not yet a working Worker session.
      summary.ok = summary.ok && summary.authenticated && summary.published && summary.workerVerified;
      status.lastResult = summary;
      status.lastCompletedAt = new Date(now()).toISOString();
      if (summary.ok) {
        status.lastSuccessAt = status.lastCompletedAt;
        status.successfulCycles++;
        status.failures = 0;
        status.nextAttemptAt = now() + Math.min(pollMs, 30000);
        status.nextScheduledAt = now() + intervalMs;
      } else {
        status.failures++;
        status.nextAttemptAt = now() + retryMs(summary);
        status.nextScheduledAt = status.nextAttemptAt;
      }
      if (summary.loginAttempted && summary.authenticated) {
        status.fullLogins++;
        status.lastFullLoginAt = status.lastCompletedAt;
      }
      if (completionRequest) {
        status.completionOutbox = {
          requestedAt: completionRequest,
          completedAt: status.lastCompletedAt,
          ok: summary.ok,
          ...(summary.reasonCode ? { reasonCode: summary.reasonCode } : {}),
          nextAttemptAt: summary.ok ? undefined : status.nextAttemptAt,
          message: summary.ok ? "Sesión persistente verificada" : "La VM reintentará automáticamente",
        };
        delete status.completionRetryAt;
        if (summary.ok) {
          status.lastCompletedRequest = completionRequest;
          delete status.pendingRequest;
        } else {
          // A newer verification supersedes an undelivered old success, also
          // when a process restart discovers that the session no longer works.
          status.pendingRequest = completionRequest;
          if (status.lastCompletedRequest === completionRequest) delete status.lastCompletedRequest;
        }
      }
      persist();
      logger(summary.ok ? "info" : "warn", "ciclo persistente", { reason, ...summary });
      await report("/native-host/event", {
        type: summary.ok ? "ok" : "error",
        via: summary.via,
        at: status.lastCompletedAt,
        hadBukealaJsession: summary.authenticated,
        message: summary.ok ? "persistent: navegador y Worker verificados" : `persistent: ${summary.reasonCode || "unverified"}`,
        // El Worker ya declara, copia y persiste postNavUrl, y su alerta de
        // Radware lo concatena al mensaje: mandarlo revive esa alerta sin
        // tocar el Worker.
        ...(summary.postNavUrl ? { postNavUrl: summary.postNavUrl } : {}),
      });
      await flushCompletion();
      return summary;
    } finally {
      inFlight = false;
    }
  }

  async function tick() {
    if (closed || inFlight) return;
    await flushCompletion();
    if (now() < status.nextAttemptAt) return;
    let pending = null;
    try { pending = await request("/native-host/check-refresh"); }
    catch { logger("warn", "no se pudo leer orden remota"); }
    if (pending?.pending && typeof pending.requestedAt === "string" &&
        pending.requestedAt !== status.lastCompletedRequest) {
      status.lastRequest = pending.requestedAt;
      status.pendingRequest = pending.requestedAt;
      persist();
      await runCycle("on-demand");
      return;
    }
    if (now() >= (status.nextScheduledAt || 0)) await runCycle("scheduled");
  }

  async function close() {
    if (closed) return;
    closed = true;
    // SIGTERM should finish the current cycle before Chromium flushes its profile.
    while (inFlight) await sleep(100);
    await manager.close();
    status.stoppedAt = new Date(now()).toISOString();
    persist();
  }

  async function run(signal) {
    // Failed attempts keep their deadline; healthy profiles reopen immediately.
    await runCycle("startup");
    while (!signal?.aborted && !closed) {
      try { await sleep(pollMs, undefined, { signal }); }
      catch (error) { if (error.name === "AbortError") break; throw error; }
      if (!signal?.aborted) await tick();
    }
    await close();
  }
  return { run, runCycle, tick, close, getStatus: () => ({ ...status }) };
}

async function main(env = process.env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const watcher = createPersistentWatcher(env);
  try { await watcher.run(controller.signal); }
  finally {
    await watcher.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

module.exports = { createPersistentWatcher, safeResult, main };
if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ level: "error", message: "persistent watcher stopped unexpectedly" }));
    process.exitCode = 2;
  });
}

MODULEEOF

cat > "$APP/persistentProbe.js" <<'MODULEEOF'
"use strict";

// This diagnostic never publishes a session or invokes messaging endpoints.
// --seed-worker is explicit migration only; normal tests never import cookies.
const fs = require("node:fs");
const { createPersistentSessionManager } = require("./persistentSession");
const { safeResult } = require("./persistentWatcher");

async function main() {
  if (!process.env.BROWSER_PROFILE_DIR) throw new Error("BROWSER_PROFILE_DIR required");
  const seed = process.argv.includes("--seed-worker");
  const restart = process.argv.includes("--restart");
  const allowLogin = process.argv.includes("--allow-login");
  const simulateSso = process.argv.includes("--simulate-sso-expiry");
  const simulateExpiry = simulateSso || process.argv.includes("--simulate-app-expiry");
  if (simulateSso && !allowLogin) throw new Error("SSO expiry simulation requires --allow-login");
  const results = [];
  let manager;
  try {
    manager = createPersistentSessionManager(process.env, { publish: false, expiryProbe: simulateExpiry });
    if (seed) {
      const base = process.env.WORKER_URL.replace(/\/capture\/?$/, "");
      const response = await fetch(`${base}/native-host/session`, {
        headers: { "X-Capture-Token": process.env.CAPTURE_TOKEN },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("seed-fetch-failed");
      const snapshot = await response.json();
      const seeded = await manager.seedCookies(snapshot.cookies, { capturedAt: snapshot.capturedAt });
      results.push({ phase: "explicit-migration", ok: seeded.ok, reasonCode: seeded.reasonCode || null });
      if (!seeded.ok) return results;
    }
    const first = await manager.renew({ allowFullLogin: allowLogin });
    results.push({ phase: "initial", ...safeResult(first) });
    let last = first;
    if (simulateExpiry && first.authenticated) {
      const reset = await manager.simulateAppSessionLoss({ includeSso: simulateSso });
      last = await manager.renew({ allowFullLogin: allowLogin });
      results.push({ phase: simulateSso ? "after-controlled-sso-session-loss" : "after-controlled-app-session-loss",
        ...reset, ...safeResult(last) });
    }
    await manager.close();
    manager = null;
    if (restart && last.authenticated) {
      manager = createPersistentSessionManager(process.env, { publish: false });
      const restored = await manager.renew({ allowFullLogin: false });
      results.push({ phase: "after-browser-restart", ...safeResult(restored) });
    }
    return results;
  } catch {
    results.push({ phase: "probe-error", ok: false, reasonCode: "probe-failed" });
    return results;
  } finally {
    if (manager) {
      try { await manager.close(); }
      catch { results.push({ phase: "browser-close", ok: false, reasonCode: "browser-close-failed" }); }
    }
    const report = {
      at: new Date().toISOString(),
      workerWrites: 0,
      importedWorkerSession: seed,
      fullLoginAllowed: allowLogin,
      expirySimulation: simulateSso ? "local-application-and-cas-cookie-removal"
        : simulateExpiry ? "local-application-cookie-removal" : null,
      results,
    };
    // Report is inside the protected profile and contains no cookies/credentials.
    if (fs.existsSync(process.env.BROWSER_PROFILE_DIR)) {
      fs.writeFileSync(`${process.env.BROWSER_PROFILE_DIR}/probe-result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    if (!results.length || results.some(result => !result.ok)) process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ ok: false, reasonCode: "probe-failed" }));
    process.exitCode = 1;
  });
}

MODULEEOF

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

# Chromium headed on a private virtual display. The site rejected the
# headless shell from this VM before showing its login form.
apt-get install -y xvfb xauth
touch /var/lib/bukeala/Xauthority
chmod 600 /var/lib/bukeala/Xauthority
if [ ! -s /var/lib/bukeala/Xauthority ]; then
  xauth -f /var/lib/bukeala/Xauthority add :99 . "$(openssl rand -hex 16)"
fi
cat > /etc/systemd/system/bukeala-display.service <<'DISPLAYUNIT'
[Unit]
Description=Private virtual display for Bukeala Chromium

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x800x24 -nolisten tcp -auth /var/lib/bukeala/Xauthority
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
DISPLAYUNIT

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
After=bukeala-display.service
Requires=bukeala-display.service

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
Environment=BROWSER_SESSION_MODE=$BROWSER_SESSION_MODE
Environment=BROWSER_PROFILE_DIR=/var/lib/bukeala/browser-profile
Environment=BROWSER_HEADLESS=0
Environment=DISPLAY=:99
Environment=XAUTHORITY=/var/lib/bukeala/Xauthority
Environment=ENABLE_FULL_LOGIN=$ENABLE_FULL_LOGIN
Environment=FULL_LOGIN_COOLDOWN_MS=1800000
ExecStart=/usr/bin/node $APP/watcher.js
UMask=0077
TimeoutStopSec=420
KillMode=mixed
Restart=always
RestartSec=15
StandardOutput=append:/var/log/bukeala.log
StandardError=append:/var/log/bukeala.log

[Install]
WantedBy=multi-user.target
UNIT

chmod 600 /etc/systemd/system/bukeala.service
systemctl daemon-reload
systemctl enable --now bukeala-display.service
systemctl enable bukeala.service
systemctl restart bukeala.service
echo "=== Bukeala setup DONE $(date) ==="
systemctl status bukeala.service --no-pager || true
