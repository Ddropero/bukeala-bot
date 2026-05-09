/**
 * /bloquear — create an agenda block (busy time / active pause).
 *
 * STATUS: STUB — endpoint not yet known.
 *
 * Investigation summary (2026-05-06):
 *   The Bukeala /admin/daily/{branch}/{date}/list response (consumed by
 *   bukeala.getAgenda) returns booking objects with `isBusyTime: bool` and
 *   `isActivePause: bool`, suggesting the platform supports two flavors of
 *   block: (a) generic "Bloqueo de agenda" (busyTime) and (b) "Pausa Activa"
 *   (activePause).
 *
 *   We confirmed those concepts exist in the UI by grepping the captured
 *   myBookings*.html / doPage-laura*.html / findAvailability.html files —
 *   they all bundle the i18n message catalog with entries like:
 *
 *     message['busyTime.addNew']     = "Agregar bloqueo de agenda";
 *     message['busyTime.title']      = "Bloqueo de agenda";
 *     message['activePause.create']  = "Crear Pausa Activa";
 *     message['activePause.success'] = "La Pausa Activa ha sido creada";
 *     message['eventDaily.busyTime.reason.select'] = "Seleccione un motivo";
 *
 *   However, NONE of the captured HARs (1.har, 2.har,
 *   appoint.tuscitasmedicas.com.har) contain a request that creates a block.
 *   The available HARs only cover login, dashboard, findAvailability and the
 *   booking/cancel flow. There are no requests to URLs containing
 *   "busyTime", "activePause", "pause", "block", or "bloqueo".
 *
 *   The frontend script that triggers block creation is almost certainly
 *   `appointMyBookings.js` (referenced from the agenda page) or one of the
 *   admin/eventDaily scripts — none of those JS files are in uploads/.
 *
 * To unblock implementation we need ONE of:
 *   - A fresh HAR captured while clicking "Agregar bloqueo de agenda" /
 *     "Crear Pausa Activa" in the Bukeala UI (open DevTools → Network →
 *     filter XHR → perform the action → save HAR with all content).
 *   - OR the source of `appointMyBookings.js` and any
 *     `eventDaily*.js` / busyTime modal script from the Bukeala static
 *     bundle.
 *
 * Once the endpoint is known, the implementation should:
 *   1. Parse args: "DD/MM/YYYY HH:MM HH:MM motivo".
 *   2. Convert times to whatever unit Bukeala uses (likely seconds since
 *      midnight — `getAgenda` results use that scale; e.g. timeFrom=44400).
 *   3. Add a `bukeala.createBusyTime(dateDdMmYyyy, areaId, fromSec, toSec,
 *      reason)` method (in bukeala.ts) that POSTs to the discovered endpoint.
 *   4. Confirm success ("✅ Bloqueado DD/MM HH:MM-HH:MM — motivo") or
 *      surface the API error.
 */
import type { Env } from "../env";

// ====================================================================
// Local Telegram helper — duplicated to keep this module self-contained.
// (Same pattern used by agendaDetail.ts.)
// ====================================================================
const TG = (token: string) => `https://api.telegram.org/bot${token}`;

async function tg(env: Env, method: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(
  env: Env,
  chat_id: string,
  text: string,
  extra: object = {},
): Promise<unknown> {
  return tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
}

// ====================================================================
// Public API
// ====================================================================

/**
 * /bloquear — STUB.
 *
 * Expected (future) syntax: `/bloquear DD/MM/YYYY HH:MM HH:MM motivo`
 *   Example: `/bloquear 06/05/2026 12:00 13:00 Almuerzo`
 *
 * Currently the endpoint that Bukeala uses to create busyTime / activePause
 * blocks is unknown — see the file header for the investigation trail. This
 * function therefore acks the user with a "pendiente" message that explains
 * exactly what HAR capture is needed to finish the work, and logs the
 * received args to make iteration easier once we have the endpoint.
 */
export async function startBloquear(
  env: Env,
  chatId: string,
  args: string,
): Promise<void> {
  const trimmed = (args ?? "").trim();
  console.log(
    `[bloquear] received args="${trimmed}" (chat ${chatId}) — stub, no endpoint yet`,
  );

  const lines = [
    "🚧 <b>/bloquear pendiente</b>",
    "",
    "Necesito una captura HAR del flujo de <i>crear bloqueo</i> en la web de Bukeala para descubrir el endpoint.",
    "",
    "<b>Cómo capturar:</b>",
    "1. Abre Bukeala en Chrome y entra a la agenda diaria.",
    "2. Abre DevTools (F12) → pestaña <b>Network</b> → filtra por <b>Fetch/XHR</b>.",
    "3. Click en <i>Agregar bloqueo de agenda</i> (o <i>Crear Pausa Activa</i>).",
    "4. Llena hora desde, hora hasta y motivo, y guarda.",
    "5. Click derecho en la lista de requests → <b>Save all as HAR with content</b>.",
    "6. Súbeme el .har — con eso identifico la URL exacta y los params.",
    "",
    "<i>(Mientras tanto el comando queda inactivo.)</i>",
  ];

  await sendMessage(env, chatId, lines.join("\n"));
}
