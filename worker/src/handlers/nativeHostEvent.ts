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

  // On a successful refresh, kick off pending-queue processing in the background
  if (event.type === "ok") {
    c.executionCtx.waitUntil(
      processPendingRequests(c.env).catch((err) => {
        console.log("[native-host-event] processPendingRequests failed:", err.message);
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
