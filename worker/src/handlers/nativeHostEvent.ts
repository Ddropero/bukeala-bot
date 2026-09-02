/**
 * Native Host event handler.
 *
 * The Native Host (local Playwright service running on the doctor's PC)
 * pings this endpoint after each refresh attempt. We:
 *   1. Append the event to a rolling log in KV (last 200 entries) for stats
 *      (`/sesion_stats` Telegram command can read it back).
 *   2. On `tgc_expired` events, send a Telegram alert so the user knows to
 *      run `node index.js --setup` again. We throttle alerts to one per hour
 *      to avoid spam.
 */
import type { Context } from "hono";
import type { Env } from "../env";
import { getDoctorRecipients } from "../users";
import { processPendingRequests } from "../claudeBookingAgent";
import { loadSession } from "../kv";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;
const KV_KEY = "nativeHost:events";
const KV_THROTTLE_KEY = "nativeHost:lastAlertAt";
const MAX_EVENTS = 200;
const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

interface NativeHostEvent {
  type: "ok" | "tgc_expired" | "error";
  at: string; // ISO timestamp
  message?: string;
  cookieCount?: number;
  durationMs?: number;
  // Diagnóstico estructurado del autoLogin de la VM (la VM no logea a journald,
  // este es el único canal remoto para saber cómo renovó la sesión).
  via?: string;              // "tgc" | "captcha" | "captcha-fallback"
  fellBack?: boolean;        // true si el TGC no dio sesión y tocó re-loguear
  hadBukealaJsession?: boolean;
  postNavUrl?: string;       // URL tras la 1ª navegación (para diagnosticar)
  tgcSource?: string;        // "file" | "worker" — de dónde salió el TGC reusado
  tgcUsedTail?: string;      // últimos 12 chars del TGC presentado a CAS
  tgcNewTail?: string;       // últimos 12 chars del TGC guardado tras el login
}

export async function handleNativeHostEvent(c: Context<{ Bindings: Env }>) {
  const token = c.req.header("X-Capture-Token");
  if (!token || token !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: Partial<NativeHostEvent>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const event: NativeHostEvent = {
    type: (body.type as NativeHostEvent["type"]) ?? "ok",
    at: body.at ?? new Date().toISOString(),
    message: body.message,
    cookieCount: body.cookieCount,
    durationMs: body.durationMs,
    via: body.via,
    fellBack: body.fellBack,
    hadBukealaJsession: body.hadBukealaJsession,
    postNavUrl: body.postNavUrl,
    tgcSource: body.tgcSource,
    tgcUsedTail: body.tgcUsedTail,
    tgcNewTail: body.tgcNewTail,
  };

  // Append to rolling log
  let events: NativeHostEvent[] = [];
  try {
    const raw = await c.env.STATE.get(KV_KEY);
    if (raw) events = JSON.parse(raw);
  } catch {
    events = [];
  }
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
  }
  await c.env.STATE.put(KV_KEY, JSON.stringify(events));

  // Trackear éxito/fallo por hora de Bogotá para detectar ventana de
  // mantenimiento nocturna de Bukeala. Si vemos consistentemente fallos
  // a la misma hora durante varios días, esa es la ventana.
  try {
    const evDate = new Date(event.at);
    // Bogotá = UTC-5
    const bogotaHour = (evDate.getUTCHours() - 5 + 24) % 24;
    const isOk = event.type === "ok";
    const key = isOk ? `bukeala:hourOk:${bogotaHour}` : `bukeala:hourFail:${bogotaHour}`;
    const prevRaw = await c.env.STATE.get(key);
    const prev = prevRaw ? parseInt(prevRaw, 10) || 0 : 0;
    await c.env.STATE.put(key, String(prev + 1), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 días de ventana de datos
    });
  } catch (e) {
    console.log("[native-host-event] hourly tracking failed:", (e as Error).message);
  }

  // Telemetría persistente (el ring buffer de 200 eventos se llena en horas
  // durante una falla). Contadores diarios por vía + vida empírica del TGC:
  // el gap entre dos logins CON captcha ≈ cuánto vivió el TGT de CAS.
  try {
    const day = event.at.slice(0, 10); // YYYY-MM-DD
    const bucket = event.type === "ok" ? `ok:${event.via ?? "unknown"}` : "error";
    const cKey = `stats:renew:${day}:${bucket}`;
    const prev = parseInt((await c.env.STATE.get(cKey)) ?? "0", 10) || 0;
    await c.env.STATE.put(cKey, String(prev + 1), { expirationTtl: 60 * 60 * 24 * 60 });

    if (event.type === "ok" && (event.via === "captcha" || event.via === "captcha-fallback")) {
      const nowMs = new Date(event.at).getTime();
      const lastRaw = await c.env.STATE.get("stats:lastCaptchaOkAt");
      if (lastRaw) {
        const gapMin = Math.round((nowMs - parseInt(lastRaw, 10)) / 60000);
        let lifes: number[] = [];
        try { lifes = JSON.parse((await c.env.STATE.get("stats:tgcLifetimes")) ?? "[]"); } catch { /* ignore */ }
        lifes.push(gapMin);
        await c.env.STATE.put("stats:tgcLifetimes", JSON.stringify(lifes.slice(-50)), {
          expirationTtl: 60 * 60 * 24 * 90,
        });
      }
      await c.env.STATE.put("stats:lastCaptchaOkAt", String(nowMs), { expirationTtl: 60 * 60 * 24 * 90 });
    }
  } catch (e) {
    console.log("[native-host-event] stats tracking failed:", (e as Error).message);
  }

  // Alerta INMEDIATA cuando 2Captcha se queda sin saldo (throttled 4h).
  // Sin esto, la caída solo se nota cuando un paciente lleva 20+ min atascado
  // (watchdog) — hoy la tormenta corrió 2h sin que nadie se enterara.
  if (event.type === "error" && /ZERO_BALANCE/i.test(event.message ?? "")) {
    const lastRaw = await c.env.STATE.get("nativeHost:zeroBalanceAlertAt");
    const now = Date.now();
    if (!lastRaw || now - parseInt(lastRaw, 10) > 4 * 60 * 60 * 1000) {
      await c.env.STATE.put("nativeHost:zeroBalanceAlertAt", String(now), {
        expirationTtl: 60 * 60 * 24,
      });
      try {
        const doctors = await getDoctorRecipients(c.env);
        for (const chat of doctors) {
          await fetch(`${TG(c.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chat,
              text:
                "🔴 <b>2Captcha SIN SALDO</b>\n\n" +
                "La VM no puede renovar la sesión de Bukeala hasta que recargues.\n\n" +
                "1. Recarga en https://2captcha.com → Add funds\n" +
                "2. Luego corre /sesion_renew\n\n" +
                "<i>Alternativa gratis: loguéate en Bukeala desde el PC y captura con la extensión — la VM rescatará el TGC sola.</i>",
              parse_mode: "HTML",
            }),
          }).catch(() => {});
        }
      } catch (e) {
        console.log("[native-host-event] zero-balance alert failed:", (e as Error).message);
      }
    }
  }

  // Alerta INMEDIATA cuando aparece el anti-bot Radware (perfdrive). Es el
  // fallo del 19-20 ago 2026: el login automático de la VM es desviado a
  // validate.perfdrive.com y bloqueado. NO se arregla solo — necesita que el
  // Dr. haga login humano en Bukeala y capture con la extensión. Sin esta
  // alerta, la caída solo se notó 7 h después. Throttle 90 min (la acción es
  // manual y el TGT dura ~6 h, así que a lo sumo un par de avisos por corte).
  const txt = ((event.message ?? "") + " " + (event.postNavUrl ?? "")).toLowerCase();
  if (event.type === "error" && /perfdrive|botmanager|validate\.perfdrive/.test(txt)) {
    const lastRaw = await c.env.STATE.get("nativeHost:radwareAlertAt");
    const now = Date.now();
    if (!lastRaw || now - parseInt(lastRaw, 10) > 90 * 60 * 1000) {
      await c.env.STATE.put("nativeHost:radwareAlertAt", String(now), { expirationTtl: 60 * 60 * 12 });
      try {
        const doctors = await getDoctorRecipients(c.env);
        for (const chat of doctors) {
          await fetch(`${TG(c.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chat,
              text:
                "🟠 <b>Bukeala bloqueó el login automático</b> (anti-bot Radware)\n\n" +
                "La VM no puede renovar sola: Colsanitas desvía el login a su sistema " +
                "anti-bot. Esto <b>necesita tu login humano</b>:\n\n" +
                "1. Entra a Bukeala en tu Chrome (tú sí pasas el anti-bot)\n" +
                "2. Abre la extensión → <b>Enviar sesión ahora</b>\n\n" +
                "<i>La VM tomará esa sesión y la mantendrá viva ~6 h. Reintentar el " +
                "login automático solo empeora las cosas, así que la VM ya no lo hace.</i>",
              parse_mode: "HTML",
            }),
          }).catch(() => {});
        }
      } catch (e) {
        console.log("[native-host-event] radware alert failed:", (e as Error).message);
      }
    }
  }

  // On a successful refresh, kick off pending-queue processing in the background
  if (event.type === "ok") {
    c.executionCtx.waitUntil(
      processPendingRequests(c.env).catch((err) => {
        console.log("[native-host-event] processPendingRequests failed:", err.message);
      }),
    );
    // Cola de comandos de Telegram (misma señal, try/catch propio para que un
    // fallo aquí no toque la cola de WhatsApp). Import dinámico: evita el ciclo
    // telegram.ts → nativeHostEvent.ts → tgPendingCommands.ts → telegram.ts.
    c.executionCtx.waitUntil(
      import("../tgPendingCommands")
        .then(({ procesarComandosPendientes }) => procesarComandosPendientes(c.env))
        .catch((err) => {
          console.log("[native-host-event] procesarComandosPendientes failed:", (err as Error).message);
        }),
    );
  }

  // On TGC expired, send a throttled Telegram alert
  if (event.type === "tgc_expired") {
    const lastAlertAt = await c.env.STATE.get(KV_THROTTLE_KEY);
    const now = Date.now();
    const shouldAlert =
      !lastAlertAt || now - parseInt(lastAlertAt, 10) > ALERT_THROTTLE_MS;

    if (shouldAlert) {
      try {
        // Tech alert — only to doctors, not secretaries
        const doctors = await getDoctorRecipients(c.env);
        for (const doctorChatId of doctors) {
          await fetch(`${TG(c.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: doctorChatId,
              text:
                "⚠️ <b>Sesión Bukeala expiró</b> (TGC murió en CAS)\n\n" +
                "El Native Host ya no puede refrescar cookies. Para volver a activar:\n\n" +
                "<code>cd C:\\Users\\dfduq\\OneDrive\\Documents\\agendamiento\\outputs\\bukeala-bot\\native-host\nnode index.js --setup</code>\n\n" +
                "Loguea en la ventana que se abre (con reCAPTCHA), espera a ver Bukeala, la ventana se cierra sola.",
              parse_mode: "HTML",
            }),
          });
        }
        await c.env.STATE.put(KV_THROTTLE_KEY, String(now), {
          expirationTtl: 60 * 60 * 24,
        });
      } catch (e) {
        console.log("[native-host-event] telegram alert failed:", (e as Error).message);
      }
    }
  }

  return c.json({ ok: true, eventsLogged: events.length });
}

/**
 * Reads the events log for use by Telegram /sesion_stats command.
 */
export async function getNativeHostEvents(env: Env): Promise<NativeHostEvent[]> {
  try {
    const raw = await env.STATE.get(KV_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ====================================================================
// TGC rescue: la VM re-bootstrapea su TGC desde la última sesión en KV
// ====================================================================

const TGC_PREFIXES = ["TGC", "CASTGC"];
const isTgcName = (n: string) => TGC_PREFIXES.some((p) => n.toUpperCase().startsWith(p));

/**
 * GET /native-host/tgc (auth: X-Capture-Token)
 *
 * Tras un reboot la VM pierde su archivo de TGC (antes vivía en /tmp) y sin
 * él CADA renovación gasta un captcha. Pero la última sesión que la propia VM
 * empujó al Worker (KV `session:active`, TTL 12h) incluye la cookie CASTGC
 * del dominio colsanitas.com. Este endpoint se la devuelve para que la VM se
 * re-bootstrapee sin gastar captcha. Solo devuelve cookies TGC — nunca el
 * JSESSIONID ni el resto de la sesión.
 */
export async function handleGetTgc(c: Context<{ Bindings: Env }>) {
  const token = c.req.header("X-Capture-Token");
  if (!token || token !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const session = await loadSession(c.env);
  if (!session) return c.json({ found: false, reason: "no session in KV" });

  const tgc = session.cookies.filter((k) => isTgcName(k.name));
  if (tgc.length === 0) {
    return c.json({ found: false, reason: "session sin cookie TGC", capturedAt: session.capturedAt });
  }
  console.log(`[tgc-rescue] entregando ${tgc.length} cookie(s) TGC (capturadas ${session.capturedAt})`);
  return c.json({ found: true, capturedAt: session.capturedAt, cookies: tgc });
}

// ====================================================================
// Refresh-on-demand: Telegram → triggers Native Host to run --setup
// ====================================================================

const KV_REFRESH_REQUEST = "nativeHost:refreshRequest";

interface RefreshRequest {
  requestedAt: string;
  requestedBy: string; // chatId or name
  pickedUpAt?: string; // when watcher saw it
  completedAt?: string;
}

/**
 * Used by /sesion_renew Telegram command. Sets the flag for the local watcher
 * to pick up.
 */
export async function requestRefresh(env: Env, requestedBy: string): Promise<void> {
  const req: RefreshRequest = {
    requestedAt: new Date().toISOString(),
    requestedBy,
  };
  await env.STATE.put(KV_REFRESH_REQUEST, JSON.stringify(req), {
    expirationTtl: 60 * 30, // request expires in 30 min if not picked up
  });
}

/**
 * Polled by the local Native Host watcher (every 30s) to check if a refresh
 * was requested. If yes, marks it as picked up so it isn't re-triggered.
 */
export async function handleCheckRefresh(c: Context<{ Bindings: Env }>) {
  const token = c.req.header("X-Capture-Token");
  if (!token || token !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const raw = await c.env.STATE.get(KV_REFRESH_REQUEST);
  if (!raw) return c.json({ pending: false });

  let req: RefreshRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    return c.json({ pending: false });
  }

  if (req.pickedUpAt) {
    // Already picked up — don't re-trigger unless completed > 5 min ago
    const since = Date.now() - new Date(req.pickedUpAt).getTime();
    if (since < 5 * 60 * 1000) {
      return c.json({ pending: false, alreadyPickedUp: true });
    }
  }

  // Mark as picked up
  req.pickedUpAt = new Date().toISOString();
  await c.env.STATE.put(KV_REFRESH_REQUEST, JSON.stringify(req), { expirationTtl: 60 * 30 });

  return c.json({ pending: true, requestedBy: req.requestedBy, requestedAt: req.requestedAt });
}

/**
 * Called by the Native Host after --setup completes (success or failure).
 * Clears the request and notifies whoever asked.
 */
export async function handleRefreshComplete(c: Context<{ Bindings: Env }>) {
  const token = c.req.header("X-Capture-Token");
  if (!token || token !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { ok?: boolean; message?: string };
  try {
    body = await c.req.json();
  } catch {
    body = { ok: false, message: "invalid json" };
  }

  const raw = await c.env.STATE.get(KV_REFRESH_REQUEST);
  if (raw) {
    try {
      const req: RefreshRequest = JSON.parse(raw);
      // Notify whoever requested
      const txt = body.ok
        ? "✅ <b>Sesión Bukeala renovada</b>\n\nYa puedes usar el bot normalmente."
        : `❌ <b>Renovación falló</b>\n\nMensaje: ${body.message ?? "n/a"}\n\nIntenta de nuevo con /sesion_renew o corre <code>node index.js --setup</code> manualmente en el PC.`;
      try {
        await fetch(`${TG(c.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: req.requestedBy,
            text: txt,
            parse_mode: "HTML",
          }),
        });
      } catch (e) {
        console.log("[refresh-complete] notify failed:", (e as Error).message);
      }
    } catch {
      // ignore
    }
  }

  await c.env.STATE.delete(KV_REFRESH_REQUEST);

  // After a successful manual refresh, also process the pending queue
  if (body.ok) {
    c.executionCtx.waitUntil(
      processPendingRequests(c.env).catch((err) => {
        console.log("[refresh-complete] processPendingRequests failed:", err.message);
      }),
    );
  }

  return c.json({ ok: true });
}
