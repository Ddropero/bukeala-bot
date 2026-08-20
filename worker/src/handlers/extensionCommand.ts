/**
 * Cola de órdenes remotas para la EXTENSIÓN del navegador del Dr.
 *
 * Problema: para refrescar la sesión de Bukeala alguien tenía que abrir el
 * popup de la extensión EN el navegador del Dr. y pulsar el botón — ni el bot
 * de Telegram ni el asistente pueden hacer ese clic. Este módulo replica el
 * patrón de refresh-on-demand de la VM (handlers/nativeHostEvent.ts:
 * requestRefresh / handleCheckRefresh / handleRefreshComplete) pero con
 * llaves KV PROPIAS (`ext:*`) para no cruzarse con la cola de la VM:
 *
 *   POST /extension/request-send  → encola la orden (Telegram /renovar_navegador o curl)
 *   GET  /extension/check-send    → la extensión sondea cada ~1 min (chrome.alarms)
 *   POST /extension/send-complete → la extensión reporta el resultado → avisamos al Dr.
 *   GET  /extension/status        → diagnóstico: último resultado + heartbeat
 *
 * IMPORTANTE: esto NO automatiza el login de Bukeala ni evade el anti-bot
 * Radware. Solo hace que el navegador del Dr. re-envíe/refresque las cookies
 * que YA tiene. Si la sesión del navegador murió de verdad, la extensión no
 * envía nada (guardia anti-envenenamiento) y aquí avisamos que hace falta
 * login humano (usuario + clave + reCAPTCHA — eso no se automatiza).
 */
import type { Context } from "hono";
import type { Env } from "../env";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

// Llaves KV propias — NO reutilizar las de la VM (nativeHost:*): la VM y la
// extensión son dos ejecutores distintos y sus colas no deben mezclarse.
const KV_SEND_REQUEST = "ext:sendRequest";
const KV_LAST_RESULT = "ext:lastResult";
const KV_LAST_SEEN = "ext:lastSeen";

// La orden expira sola si nadie la recoge (navegador cerrado): 15 min bastan
// para que el Dr. entienda que "no pasó nada" y no queden órdenes zombis que
// disparen renovaciones horas después, cuando ya nadie las espera.
const REQUEST_TTL_S = 60 * 15;

// Ventana "ya recogida": igual que handleCheckRefresh. Si la extensión ya
// recogió la orden hace < 5 min, no re-disparamos (evita dobles ejecuciones
// si el reporte de completado se pierde o tarda).
const PICKED_UP_WINDOW_MS = 5 * 60 * 1000;

interface ExtSendRequest {
  requestedAt: string;
  requestedBy: string; // chatId de Telegram, o etiqueta tipo "manual-curl"
  pickedUpAt?: string; // cuándo la recogió la extensión (para no re-disparar)
}

interface ExtSendResult {
  ok: boolean;
  reason?: string;
  cookieCount?: number;
  at: string; // cuándo reportó la extensión
  requestedBy?: string;
}

/**
 * Auth: header X-Capture-Token o query ?token= (mismo esquema que el resto de
 * endpoints de captura/diagnóstico). Query incluido porque curl/Telegram lo
 * usan así y la extensión manda header.
 */
function autorizado(c: Context<{ Bindings: Env }>): boolean {
  const token = c.req.header("X-Capture-Token") ?? c.req.query("token");
  return !!token && token === c.env.CAPTURE_TOKEN;
}

/**
 * Encola la orden de re-envío. La usa el comando /renovar_navegador de
 * Telegram y el endpoint POST /extension/request-send. Análoga a
 * requestRefresh() de la VM.
 */
export async function requestExtensionSend(env: Env, requestedBy: string): Promise<void> {
  const req: ExtSendRequest = {
    requestedAt: new Date().toISOString(),
    requestedBy,
  };
  await env.STATE.put(KV_SEND_REQUEST, JSON.stringify(req), {
    expirationTtl: REQUEST_TTL_S,
  });
}

/**
 * Minutos desde el último sondeo de la extensión, o null si nunca ha
 * reportado (o hace tanto que el heartbeat ya expiró). Lo usa Telegram para
 * advertir "tu navegador puede estar cerrado" ANTES de prometer confirmación.
 */
export async function getExtensionLastSeenMin(env: Env): Promise<number | null> {
  const raw = await env.STATE.get(KV_LAST_SEEN);
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

/**
 * POST /extension/request-send?token=<CAPTURE_TOKEN>[&by=<quien>]
 *
 * Encola la orden desde fuera de Telegram (curl, asistente, otro sistema).
 * `by` opcional identifica quién pidió; si es un chatId numérico de Telegram,
 * send-complete le confirmará por ahí.
 */
export async function handleExtensionRequestSend(c: Context<{ Bindings: Env }>) {
  if (!autorizado(c)) return c.json({ error: "unauthorized" }, 401);

  let by = c.req.query("by") ?? "";
  // También aceptamos body JSON { requestedBy } por simetría con otros POSTs.
  try {
    const body = (await c.req.json()) as { requestedBy?: string };
    if (body?.requestedBy) by = String(body.requestedBy);
  } catch {
    /* sin body: seguimos con el query param */
  }

  await requestExtensionSend(c.env, by || "manual-curl");
  return c.json({ ok: true, message: "orden encolada; la extensión sondea cada ~1 min" });
}

/**
 * GET /extension/check-send?token=<CAPTURE_TOKEN>
 *
 * Sondeado por la extensión (chrome.alarms, cada ~1 min). Misma lógica que
 * handleCheckRefresh: si hay orden pendiente la devuelve y la marca como
 * recogida para no re-disparar dobles. Además guarda el heartbeat
 * `ext:lastSeen` en CADA sondeo — es la señal de que el navegador del Dr.
 * está abierto y la extensión viva (lo consulta /extension/status y el
 * comando /renovar_navegador).
 */
export async function handleExtensionCheckSend(c: Context<{ Bindings: Env }>) {
  if (!autorizado(c)) return c.json({ error: "unauthorized" }, 401);

  // Heartbeat SIEMPRE, haya o no orden: cada sondeo prueba que la extensión
  // vive. TTL 30 días: si no reporta en un mes, "nunca visto" es lo honesto.
  await c.env.STATE.put(KV_LAST_SEEN, new Date().toISOString(), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  // no-store: las respuestas GET pueden quedar cacheadas en el edge y un
  // "pending:true" cacheado dispararía renovaciones fantasma.
  const noCache = { "Cache-Control": "no-store" };

  const raw = await c.env.STATE.get(KV_SEND_REQUEST);
  if (!raw) return c.json({ pending: false }, 200, noCache);

  let req: ExtSendRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    return c.json({ pending: false }, 200, noCache);
  }

  if (req.pickedUpAt) {
    // Ya recogida — no re-disparar salvo que la recogida sea vieja (> 5 min:
    // la ejecución anterior murió sin reportar, p. ej. el service worker de
    // MV3 se durmió a mitad de camino).
    const since = Date.now() - new Date(req.pickedUpAt).getTime();
    if (since < PICKED_UP_WINDOW_MS) {
      return c.json({ pending: false, alreadyPickedUp: true }, 200, noCache);
    }
  }

  // Marcar como recogida (conserva el TTL corto: si la ejecución muere, la
  // orden expira sola en vez de quedar pegada).
  req.pickedUpAt = new Date().toISOString();
  await c.env.STATE.put(KV_SEND_REQUEST, JSON.stringify(req), { expirationTtl: REQUEST_TTL_S });

  return c.json(
    { pending: true, requestedAt: req.requestedAt, requestedBy: req.requestedBy },
    200,
    noCache,
  );
}

/**
 * POST /extension/send-complete?token=<CAPTURE_TOKEN>
 * Body: { ok: boolean, reason?: string, cookieCount?: number }
 *
 * La extensión reporta cómo le fue. Limpiamos la orden, guardamos el último
 * resultado en KV (consultable en /extension/status) y le confirmamos por
 * Telegram a quien pidió (si `requestedBy` es un chatId). Análogo a
 * handleRefreshComplete de la VM.
 *
 * NOTA: si ok=true, las cookies ya entraron por POST /capture, que dispara
 * processPendingRequests solo — no lo repetimos aquí para no procesar doble.
 */
export async function handleExtensionSendComplete(c: Context<{ Bindings: Env }>) {
  if (!autorizado(c)) return c.json({ error: "unauthorized" }, 401);

  let body: { ok?: boolean; reason?: string; cookieCount?: number };
  try {
    body = await c.req.json();
  } catch {
    body = { ok: false, reason: "invalid json" };
  }

  // Recuperar quién pidió ANTES de borrar la orden (para confirmarle).
  let requestedBy: string | undefined;
  const raw = await c.env.STATE.get(KV_SEND_REQUEST);
  if (raw) {
    try {
      requestedBy = (JSON.parse(raw) as ExtSendRequest).requestedBy;
    } catch {
      /* orden corrupta: igual la vamos a borrar */
    }
  }

  const result: ExtSendResult = {
    ok: !!body.ok,
    reason: body.reason,
    cookieCount: body.cookieCount,
    at: new Date().toISOString(),
    requestedBy,
  };
  // 7 días de retención: suficiente para diagnosticar "¿qué pasó la última vez?"
  await c.env.STATE.put(KV_LAST_RESULT, JSON.stringify(result), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
  await c.env.STATE.delete(KV_SEND_REQUEST);

  // Confirmar por Telegram SOLO si quien pidió es un chatId numérico (si vino
  // de curl con by=manual-curl no hay a quién escribirle).
  if (requestedBy && /^-?\d+$/.test(requestedBy)) {
    // El caso "sin sesión" merece mensaje propio y explícito: la renovación
    // remota NO puede resucitar una sesión muerta — eso exige login humano
    // (usuario + clave + reCAPTCHA) y no se automatiza (anti-bot Radware).
    const sinSesion = /sin sesi[oó]n|login humano/i.test(body.reason ?? "");
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const txt = result.ok
      ? `✅ <b>Navegador renovó la sesión</b>\n\nTu navegador re-envió la sesión de Bukeala (${result.cookieCount ?? "?"} cookies). Ya puedes usar el bot normalmente.`
      : sinSesion
        ? "❌ <b>Tu navegador no tiene sesión de Bukeala</b>\n\nLa renovación remota solo re-envía la sesión que el navegador YA tiene — y la tuya expiró. Hace falta <b>login humano</b>:\n\n1. Entra a Bukeala en tu navegador (usuario + clave + reCAPTCHA)\n2. La extensión captura y envía la sesión sola tras el login\n\n<i>Esto no se puede automatizar (anti-bot Radware).</i>"
        : `❌ <b>El navegador no pudo renovar</b>\n\nMotivo: ${esc(body.reason ?? "desconocido")}\n\nReintenta con /renovar_navegador o revisa /extension/status.`;
    try {
      await fetch(`${TG(c.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: requestedBy, text: txt, parse_mode: "HTML" }),
      });
    } catch (e) {
      console.log("[ext-send-complete] notify failed:", (e as Error).message);
    }
  }

  return c.json({ ok: true });
}

/**
 * GET /extension/status?token=<CAPTURE_TOKEN>
 *
 * Diagnóstico en una sola llamada: último resultado reportado, si hay orden
 * pendiente y hace cuánto la extensión dio señales de vida (heartbeat). Con
 * esto se responde "¿el navegador del Dr. está abierto?" sin molestarlo.
 */
export async function handleExtensionStatus(c: Context<{ Bindings: Env }>) {
  if (!autorizado(c)) return c.json({ error: "unauthorized" }, 401);

  const parse = (r: string | null) => {
    try {
      return r ? JSON.parse(r) : null;
    } catch {
      return null;
    }
  };

  const [resultRaw, requestRaw, lastSeenRaw] = await Promise.all([
    c.env.STATE.get(KV_LAST_RESULT),
    c.env.STATE.get(KV_SEND_REQUEST),
    c.env.STATE.get(KV_LAST_SEEN),
  ]);

  const lastSeenAt = lastSeenRaw ?? null;
  const haceMin = lastSeenAt
    ? Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 60000)
    : null;

  return c.json(
    {
      ultimoResultado: parse(resultRaw),
      pendiente: parse(requestRaw),
      ultimoContactoExtension: lastSeenAt ? { at: lastSeenAt, haceMin } : null,
      // Umbral que usa Telegram para advertir "puede estar cerrado".
      navegadorVivo: haceMin !== null && haceMin <= 5,
    },
    200,
    { "Cache-Control": "no-store" },
  );
}
