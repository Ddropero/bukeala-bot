// v5: CAS heartbeat + auto-envío de sesión.
//
// El TGC del CAS de Apereo (app01.colsanitas.com) expira por tiempo (~8h)
// independientemente de la actividad. Sin renovación, todo el sistema falla.
// Renovarlo desde el Worker es imposible: Radware Bot Manager bloquea
// los IPs de Cloudflare con validate.perfdrive.com.
//
// La solución: este service worker (que vive en el contexto del navegador
// con el TLS fingerprint real, las cookies del usuario, y headers de
// Chrome) hace un "ping" al CAS cada 5 min. Esto:
//   1. Refresca el "last-activity" del TGC en el servidor CAS → no expira
//      por timeout de inactividad
//   2. Pasa por el flujo CAS → Bukeala normal, lo que renueva JSESSIONID
//   3. La extensión luego captura las cookies frescas y las envía al worker
//
// Como vive en el service worker y no en una tab, funciona aún si el
// usuario cerró la tab de Bukeala — solo necesita tener Chrome abierto.

const ALARM_NAME = "bukeala-auto-send";
const PERIOD_MIN = 5; // antes 10 — ahora cada 5 min, alineado con el cron del worker

const CAS_LOGIN_URL = "https://app01.colsanitas.com/cas/login";
const SERVICE_URL = "https://appoint.tuscitasmedicas.com/keraltyadscritos/cas/login";
const APPOINT_PING_URL =
  "https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability";

// ============================================================
// CAS heartbeat — keep TGC alive
// ============================================================
async function casHeartbeat() {
  // Hit the CAS login endpoint with credentials. Browser sends TGC cookie.
  // CAS sees valid TGC → 302 to service URL with ?ticket=ST-... → SP
  // validates ticket → fresh JSESSIONID for tuscitasmedicas.com.
  // The act of hitting CAS itself refreshes its session timer.
  try {
    const url = `${CAS_LOGIN_URL}?service=${encodeURIComponent(SERVICE_URL)}`;
    const r = await fetch(url, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      // Browser-natural headers
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
      },
    });
    console.log(`[bukeala-bg] CAS heartbeat → ${r.status} ${r.url}`);
    await chrome.storage.local.set({
      lastCasHeartbeatAt: new Date().toISOString(),
      lastCasHeartbeatStatus: r.status,
    });
    return { ok: r.ok || r.redirected, status: r.status };
  } catch (e) {
    console.log("[bukeala-bg] CAS heartbeat error:", e.message);
    await chrome.storage.local.set({
      lastCasHeartbeatAt: new Date().toISOString(),
      lastCasHeartbeatError: e.message,
    });
    return { ok: false, error: e.message };
  }
}

// Light ping to the appoint host, just to make sure JSESSIONID gets touched.
async function appointPing() {
  try {
    const r = await fetch(APPOINT_PING_URL, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/html" },
    });
    console.log(`[bukeala-bg] appoint ping → ${r.status} ${r.url}`);
    return { ok: r.ok || r.redirected, status: r.status };
  } catch (e) {
    console.log("[bukeala-bg] appoint ping error:", e.message);
    return { ok: false, error: e.message };
  }
}

// ============================================================
// Cookie capture & send
// ============================================================
async function sendSessionToWorker() {
  const stored = await chrome.storage.local.get(["workerUrl", "captureToken"]);
  const workerUrl = stored.workerUrl;
  const captureToken = stored.captureToken;
  if (!workerUrl || !captureToken) {
    console.log("[bukeala-bg] missing worker url or token, skip");
    return { ok: false, reason: "no_config" };
  }

  let allCookies = [];
  try {
    const all = await chrome.cookies.getAll({});
    const seen = new Set();
    for (const c of all) {
      const d = (c.domain || "").toLowerCase();
      if (!d.includes("tuscitasmedicas.com") && !d.includes("colsanitas.com")) continue;
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allCookies.push(c);
    }
  } catch (e) {
    console.log("[bukeala-bg] cookies error:", e.message);
    return { ok: false, reason: "cookies_error" };
  }

  if (allCookies.length === 0) {
    console.log("[bukeala-bg] no cookies for relevant domains, skip");
    return { ok: false, reason: "no_cookies" };
  }

  try {
    const res = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Capture-Token": captureToken,
      },
      body: JSON.stringify({
        capturedAt: new Date().toISOString(),
        cookies: allCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expirationDate,
          httpOnly: c.httpOnly,
        })),
      }),
    });
    const ok = res.ok;
    const body = await res.json().catch(() => ({}));
    console.log(`[bukeala-bg] send result: ${res.status}`, body);
    await chrome.storage.local.set({
      lastAutoSendAt: new Date().toISOString(),
      lastAutoSendOk: ok,
      lastAutoSendCount: body.cookieCount ?? allCookies.length,
    });
    return { ok, count: allCookies.length, body };
  } catch (e) {
    console.log("[bukeala-bg] network error:", e.message);
    await chrome.storage.local.set({
      lastAutoSendAt: new Date().toISOString(),
      lastAutoSendOk: false,
      lastAutoSendError: e.message,
    });
    return { ok: false, reason: "network_error" };
  }
}

// ============================================================
// Tick: heartbeat + ping + capture & send
// ============================================================
async function autoTick() {
  const stored = await chrome.storage.local.get(["autoMode"]);
  if (!stored.autoMode) {
    console.log("[bukeala-bg] autoMode off, skip tick");
    return;
  }

  // 1. Refresh CAS-TGC. This is the key step that worker can't do itself.
  await casHeartbeat();
  // 2. Touch JSESSIONID at appoint host so cookies are fresh.
  await appointPing();
  // 3. Capture all cookies and send to worker (which decrypts + uses them).
  await sendSessionToWorker();
}

async function startAutoMode() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MIN });
  console.log(`[bukeala-bg] auto-mode alarm created (every ${PERIOD_MIN}min)`);
}

async function stopAutoMode() {
  await chrome.alarms.clear(ALARM_NAME);
  console.log("[bukeala-bg] auto-mode alarm cleared");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) autoTick();
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["autoMode"]);
  if (stored.autoMode) await startAutoMode();
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get(["autoMode"]);
  if (stored.autoMode) await startAutoMode();
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "manual_send") {
      // Manual trigger does the full tick: CAS heartbeat + capture
      const heartbeat = await casHeartbeat();
      await appointPing();
      const r = await sendSessionToWorker();
      sendResponse({ ...r, heartbeat });
      return;
    }
    if (msg?.type === "set_auto_mode") {
      await chrome.storage.local.set({ autoMode: !!msg.enabled });
      if (msg.enabled) await startAutoMode();
      else await stopAutoMode();
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, reason: "unknown_msg" });
  })();
  return true; // async response
});
