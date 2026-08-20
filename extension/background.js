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

// URL de login HUMANO: el mismo flujo CAS→Bukeala que usa casHeartbeat. Es la
// que el médico debe abrir para meter usuario+contraseña+reCAPTCHA en SU Chrome
// real (el único que pasa el anti-bot de Radware). No la inventamos: se arma
// con las constantes de arriba para no desincronizarnos del heartbeat.
const CAS_FULL_LOGIN_URL = `${CAS_LOGIN_URL}?service=${encodeURIComponent(SERVICE_URL)}`;

// Vigilancia + aviso accionable.
const NOTIF_ID = "bukeala-session-down";
const NOTIFY_COOLDOWN_MIN = 40; // anti-spam: no molestar más de 1 vez cada ~40 min

// Captura inmediata tras el login: cookie de sesión de Bukeala.
const SESSION_COOKIE_NAME = "JSESSIONID";
const SESSION_COOKIE_DOMAIN = "tuscitasmedicas.com";
const CAPTURE_DEBOUNCE_MS = 4000; // coalesce los eventos de carga en un solo envío

// URL a la que mandamos al doctor cuando toca re-login: el

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
// Además decide si ESTE navegador está autenticado: la URL final tras seguir
// redirects delata la sesión (si acaba en el login de CAS, no lo está).
async function appointPing() {
  try {
    const r = await fetch(APPOINT_PING_URL, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/html" },
    });
    const finalUrl = r.url || "";
    const authenticated =
      r.ok &&
      !finalUrl.includes("/cas/login") &&
      !finalUrl.includes("/authentication/login");
    console.log(`[bukeala-bg] appoint ping → ${r.status} ${finalUrl} (auth=${authenticated})`);
    return { ok: r.ok || r.redirected, status: r.status, url: finalUrl, authenticated };
  } catch (e) {
    console.log("[bukeala-bg] appoint ping error:", e.message);
    // Error de red: no podemos concluir que no esté autenticado.
    return { ok: false, error: e.message, authenticated: null };
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

    // Motivo legible. El 409 es el guardia anti-envenenamiento del Worker:
    // NO es un fallo del sistema, es que este navegador no tiene sesión válida
    // y el Worker conservó la buena (la de la VM).
    const reason =
      res.status === 409
        ? "Tu navegador no tiene sesión válida de Bukeala. El Worker conservó la sesión buena (la de la VM). Loguéate en Bukeala en otra pestaña si quieres enviar la tuya."
        : ok
          ? null
          : (body.detail || body.error || `HTTP ${res.status}`);

    const patch = {
      lastAutoSendAt: new Date().toISOString(),
      lastAutoSendOk: ok,
      lastAutoSendCount: body.cookieCount ?? allCookies.length,
      lastAutoSendError: reason,
    };
    // Marca el ÚLTIMO envío exitoso (lo muestra el popup: "hace N min").
    if (ok) patch.lastSuccessAt = new Date().toISOString();
    await chrome.storage.local.set(patch);
    return { ok, status: res.status, count: allCookies.length, body, reason };
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
// Vigilancia del estado real + aviso accionable
// ============================================================

// La workerUrl guardada termina en /capture; la base es todo menos ese sufijo.
function workerBaseFrom(workerUrl) {
  return String(workerUrl || "").replace(/\/capture\/?$/, "");
}

// Veredicto AUTORITATIVO del Worker: ¿la sesión que ÉL tiene sirve ahora mismo?
// GET /debug/measure (sin action = probe) → { alive: bool, ... } SIN renovar.
// { known:false } si falta config o falla la red: en ese caso no concluimos nada.
async function checkWorkerAlive() {
  const stored = await chrome.storage.local.get(["workerUrl", "captureToken"]);
  const base = workerBaseFrom(stored.workerUrl);
  if (!base || !stored.captureToken) return { known: false };
  try {
    const url =
      `${base}/debug/measure?token=${encodeURIComponent(stored.captureToken)}&_=${Date.now()}`;
    const r = await fetch(url, { method: "GET" });
    const j = await r.json().catch(() => ({}));
    await chrome.storage.local.set({
      lastMeasureAt: new Date().toISOString(),
      lastMeasureAlive: !!j.alive,
    });
    return { known: true, alive: !!j.alive, raw: j };
  } catch (e) {
    console.log("[bukeala-bg] measure error:", e.message);
    return { known: false, error: e.message };
  }
}

// Abre (o enfoca si ya existe) la pestaña de login del CAS. NO automatiza NADA
// del login: solo lo deja a un clic; el usuario+clave+reCAPTCHA los hace el humano.
async function openBukealaLogin() {
  try {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => {
      const u = t.url || "";
      return u.includes("app01.colsanitas.com/cas/login") ||
             u.includes("appoint.tuscitasmedicas.com");
    });
    if (hit && hit.id != null) {
      await chrome.tabs.update(hit.id, { active: true });
      if (hit.windowId != null) {
        try { await chrome.windows.update(hit.windowId, { focused: true }); } catch (_) {}
      }
      return;
    }
    await chrome.tabs.create({ url: CAS_FULL_LOGIN_URL });
  } catch (e) {
    console.log("[bukeala-bg] openBukealaLogin error:", e.message);
  }
}

// Aviso accionable con anti-spam DURO. El estado vive en chrome.storage.local
// porque el service worker se duerme y perdería cualquier variable en memoria:
//   - notifyPending: ya avisamos y el médico aún no ha hecho nada → no repetir.
//   - lastNotifyAt: no más de un aviso cada NOTIFY_COOLDOWN_MIN.
async function maybeNotifySessionDown(mensaje) {
  const now = Date.now();
  const st = await chrome.storage.local.get(["lastNotifyAt", "notifyPending"]);
  if (st.notifyPending) return;
  if (st.lastNotifyAt && now - st.lastNotifyAt < NOTIFY_COOLDOWN_MIN * 60000) return;
  try {
    await chrome.notifications.create(NOTIF_ID, {
      type: "basic",
      iconUrl: "icon.png",
      title: "Sesión de Bukeala expirada",
      message: mensaje || "Clic aquí para volver a iniciar sesión en Bukeala.",
      priority: 2,
      requireInteraction: true, // es accionable: que no se auto-descarte sola
    });
    await chrome.storage.local.set({ lastNotifyAt: now, notifyPending: true });
    console.log("[bukeala-bg] aviso de sesión caída mostrado");
  } catch (e) {
    console.log("[bukeala-bg] notifications.create error:", e.message);
  }
}

// La sesión volvió a estar sana → retirar el aviso y rearmar para la próxima caída.
async function clearSessionDownNotification() {
  try { await chrome.notifications.clear(NOTIF_ID); } catch (_) {}
  const st = await chrome.storage.local.get(["notifyPending"]);
  if (st.notifyPending) await chrome.storage.local.set({ notifyPending: false });
}

// Clic en el aviso → abrir el login y rearmar. Dejamos lastNotifyAt intacto:
// el cooldown evita re-avisar de inmediato mientras el médico se loguea.
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTIF_ID) return;
  await openBukealaLogin();
  try { await chrome.notifications.clear(NOTIF_ID); } catch (_) {}
  await chrome.storage.local.set({ notifyPending: false });
});

// ============================================================
// Captura inmediata tras el login (segundos, no 5 min)
// ============================================================
// El timer vive en memoria a propósito: es solo un debounce de segundos, dentro
// de la ventana que Chrome mantiene vivo el SW tras un evento. Si aun así el SW
// muriera antes de disparar, el tick de 5 min recoge la sesión igualmente.
let captureTimer = null;

function scheduleImmediateCapture(motivo) {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    captureTimer = null;
    const stored = await chrome.storage.local.get(["autoMode"]);
    if (!stored.autoMode) return; // respeta el interruptor del médico
    console.log(`[bukeala-bg] captura inmediata (${motivo})`);
    // MISMA guardia anti-envenenamiento que autoTick: enviar SOLO si este
    // navegador quedó autenticado. authenticated===false → no enviar (no pisar
    // la sesión buena); null por error de red → sí (el Worker revalida antes).
    const ping = await appointPing();
    if (ping.authenticated === false) {
      console.log("[bukeala-bg] captura inmediata: navegador sin sesión válida → no se envía");
      return;
    }
    const r = await sendSessionToWorker();
    if (r && r.ok) await clearSessionDownNotification(); // login logrado → quita el aviso
  }, CAPTURE_DEBOUNCE_MS);
}

// Disparador principal: cambió la cookie de sesión de Bukeala (lo típico tras
// completar el login CAS→Bukeala). Con el permiso "cookies" el evento llega
// incluso para JSESSIONID, que es HttpOnly.
chrome.cookies.onChanged.addListener((info) => {
  if (info.removed) return;
  const ck = info.cookie || {};
  const dom = (ck.domain || "").toLowerCase();
  if (ck.name === SESSION_COOKIE_NAME && dom.includes(SESSION_COOKIE_DOMAIN)) {
    scheduleImmediateCapture("cookie JSESSIONID de Bukeala");
  }
});

// Respaldo: una pestaña terminó de cargar en el host de citas de Bukeala.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const u = (tab && tab.url) || "";
  if (u.includes("appoint.tuscitasmedicas.com")) {
    scheduleImmediateCapture("pestaña de Bukeala cargada");
  }
});

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
  const ping = await appointPing();
  // 2b. Veredicto autoritativo del Worker (para el estado del popup y el aviso).
  const worker = await checkWorkerAlive();

  // 3. Enviar SOLO si este navegador está realmente autenticado.
  //
  // Antes se enviaba siempre. Si el Chrome del doctor tenía la sesión de
  // Bukeala caducada (pasa a diario), reenviaba cookies muertas cada 5 min y
  // PISABA la sesión buena que mantiene la VM 24/7 → /agenda caído a ratos.
  // Medido el 30/jul/2026: disponibilidad 20-30% mientras el PC estuvo
  // encendido. El Worker ahora también rechaza estos pushes (409), pero no
  // enviarlos de entrada evita el ruido.
  //
  // authenticated === null → error de red: no concluimos nada, mejor enviar
  // (la VM es la fuente principal y el Worker valida antes de reemplazar).
  if (ping.authenticated === false) {
    console.log("[bukeala-bg] navegador NO autenticado en Bukeala → no se envía (evita pisar la sesión buena)");
    await chrome.storage.local.set({
      lastAutoSendAt: new Date().toISOString(),
      lastAutoSendOk: false,
      lastAutoSendError: "navegador sin sesión de Bukeala — no se envió",
    });
    // Navegador sin sesión = hace falta un login HUMANO (usuario+clave+reCAPTCHA):
    // eso no se automatiza, así que avisamos de forma accionable (con anti-spam).
    //
    // Sólo disparamos el aviso por este caso (navegador caído), NO por
    // worker.alive===false a secas: si el navegador SÍ está autenticado pero el
    // Worker está caído, el envío de más abajo lo repara solo — avisar ahí sería
    // un falso positivo (el médico ya está logueado y no tendría nada que hacer).
    await maybeNotifySessionDown("Tu sesión de Bukeala expiró. Clic para volver a entrar.");
    return;
  }

  // 4. Capture all cookies and send to worker (which decrypts + uses them).
  await sendSessionToWorker();

  // 5. Navegador autenticado (o red incierta): el sistema puede auto-repararse
  // con el envío de arriba. Si hay evidencia de salud, retiramos el aviso
  // pendiente para rearmar la vigilancia de cara a la próxima caída real.
  if (ping.authenticated === true || worker.alive === true) {
    await clearSessionDownNotification();
  }
}

async function startAutoMode() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MIN });
  console.log(`[bukeala-bg] auto-mode alarm created (every ${PERIOD_MIN}min)`);
}

async function stopAutoMode() {
  await chrome.alarms.clear(ALARM_NAME);
  console.log("[bukeala-bg] auto-mode alarm cleared");
}

// ============================================================
// Órdenes remotas (Worker → extensión): renovar SIN abrir el popup
// ============================================================
// Antes, para renovar había que abrir el popup EN este navegador y pulsar el
// botón — ni el bot de Telegram ni el asistente pueden hacer ese clic. Ahora
// el Worker mantiene una cola (KV ext:sendRequest, la llena /renovar_navegador
// o POST /extension/request-send) y este sondeo la recoge y ejecuta la MISMA
// secuencia del botón manual. 1 min es el período mínimo de chrome.alarms en
// MV3; cada sondeo además deja heartbeat en el Worker ("navegador vivo").
const REMOTE_ALARM_NAME = "bukeala-remote-send-poll";
const REMOTE_POLL_PERIOD_MIN = 1;

async function startRemotePoll() {
  await chrome.alarms.create(REMOTE_ALARM_NAME, { periodInMinutes: REMOTE_POLL_PERIOD_MIN });
  console.log(`[bukeala-bg] remote-poll alarm created (every ${REMOTE_POLL_PERIOD_MIN}min)`);
}

// Reporta al Worker cómo terminó la orden (él le confirma al Dr. por Telegram).
// Nunca lanza: si el reporte falla, la orden expira sola en el Worker (TTL).
async function reportRemoteSendResult(base, captureToken, result) {
  try {
    await fetch(`${base}/extension/send-complete?token=${encodeURIComponent(captureToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
  } catch (e) {
    console.log("[bukeala-bg] send-complete error:", e.message);
  }
}

async function remoteSendTick() {
  const stored = await chrome.storage.local.get(["workerUrl", "captureToken"]);
  const base = workerBaseFrom(stored.workerUrl);
  const captureToken = stored.captureToken;
  if (!base || !captureToken) return; // sin config no hay a quién preguntarle

  // ¿Hay orden pendiente? cb=<random> + no-store porque las respuestas GET de
  // /extension pueden quedar cacheadas en el edge de Cloudflare, y un
  // "pending:true" cacheado dispararía renovaciones fantasma.
  let pending = false;
  let requestedAt = null;
  try {
    const cb = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `${base}/extension/check-send?token=${encodeURIComponent(captureToken)}&cb=${cb}`;
    const r = await fetch(url, { method: "GET", cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    pending = !!j.pending;
    requestedAt = j.requestedAt || null;
  } catch (e) {
    // Red caída o Worker inaccesible: nada que hacer hasta el próximo tick.
    console.log("[bukeala-bg] check-send error:", e.message);
    return;
  }
  if (!pending) return;

  console.log(`[bukeala-bg] orden remota de renovación recibida (pedida ${requestedAt || "?"})`);
  await chrome.storage.local.set({ lastRemoteOrderAt: new Date().toISOString() });

  // Secuencia COMPLETA de renovación — la misma del botón del popup
  // (manual_send): refrescar el TGC en CAS, tocar el JSESSIONID y enviar.
  // Una orden explícita se ejecuta aunque autoMode esté apagado: apagado
  // significa "no envíes solo", no "desobedece órdenes directas".
  await casHeartbeat();
  const ping = await appointPing();

  // MISMA guardia anti-envenenamiento de autoTick: si ESTE navegador no está
  // autenticado, enviar sus cookies muertas pisaría la sesión buena del
  // Worker. No se envía y se reporta el motivo para que el bot le diga al Dr.
  // que hace falta login humano (reCAPTCHA + anti-bot Radware: no se
  // automatiza). authenticated === null (error de red) → sí se envía, como en
  // autoTick: el Worker revalida antes de reemplazar.
  if (ping.authenticated === false) {
    console.log("[bukeala-bg] orden remota: navegador sin sesión → NO se envía");
    await maybeNotifySessionDown("El bot pidió renovar, pero tu sesión de Bukeala expiró. Clic para volver a entrar.");
    await reportRemoteSendResult(base, captureToken, {
      ok: false,
      reason: "navegador sin sesión — requiere login humano",
      cookieCount: 0,
    });
    return;
  }

  const r = await sendSessionToWorker();
  if (r && r.ok) await clearSessionDownNotification(); // envío logrado → quita el aviso
  await reportRemoteSendResult(base, captureToken, {
    ok: !!(r && r.ok),
    reason: (r && r.reason) || undefined,
    cookieCount: (r && r.count) || 0,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) autoTick();
  if (alarm.name === REMOTE_ALARM_NAME) remoteSendTick();
});

chrome.runtime.onInstalled.addListener(async () => {
  // Reactivación por defecto (ago 2026): tras el bloqueo anti-bot de Radware,
  // el login automático de la VM ya no pasa; la sesión se siembra desde ESTE
  // navegador humano, así que el auto-envío pasa a ser el sostén principal.
  // Por eso al (re)instalar o RECARGAR la extensión arranca ENCENDIDO. Si
  // alguna vez estorba, se apaga desde el popup (dura hasta la próxima recarga).
  await chrome.storage.local.set({ autoMode: true });
  await startAutoMode();
  // El sondeo de órdenes remotas arranca SIEMPRE, independiente de autoMode:
  // una orden explícita (/renovar_navegador) debe funcionar aunque el envío
  // automático esté apagado. La guardia anti-envenenamiento sigue aplicando.
  await startRemotePoll();
  console.log("[bukeala-bg] auto-mode ACTIVADO por defecto al (re)instalar");
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.local.get(["autoMode"]);
  if (stored.autoMode) await startAutoMode();
  // Ver arriba: el sondeo remoto no depende del interruptor de auto-modo.
  await startRemotePoll();
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "manual_send") {
      // Manual trigger does the full tick: CAS heartbeat + capture
      const heartbeat = await casHeartbeat();
      await appointPing();
      const r = await sendSessionToWorker();
      if (r?.ok) await clearSessionDownNotification(); // envío logrado → quita el aviso
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
    if (msg?.type === "check_alive") {
      // El popup pregunta el veredicto del Worker para pintar VIVA/CAÍDA.
      const r = await checkWorkerAlive();
      sendResponse(r);
      return;
    }
    if (msg?.type === "open_login") {
      // El popup pide abrir la pestaña de login (sesión caída).
      await openBukealaLogin();
      await chrome.storage.local.set({ notifyPending: false });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, reason: "unknown_msg" });
  })();
  return true; // async response
});
