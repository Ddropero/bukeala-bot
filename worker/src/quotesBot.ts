/**
 * Bot de COTIZACIONES — gestionado por Andrea (encargada de ventas).
 *
 * Tres orígenes posibles para una cotización:
 *   1. wa_ai      — la AI de WhatsApp detectó intent "precio" y llamó request_quote
 *   2. wa_doctor  — el doctor escribió "cotización" en @consultadavid_bot al
 *                   responderle al paciente → se delega a Andrea con contexto
 *   3. manual     — Andrea inicia con /cotizar <num> <proc> <precio>
 *
 * Andrea opera desde su bot dedicado @cotizadavid_bot. Cuando manda una
 * cotización (sea con texto libre en modo respuesta, foto, o /cotizar) se
 * relaya al WhatsApp del paciente y queda registrada en el historial.
 *
 * KV:
 *   quote:pending:list           — array de tickets pendientes (max 50)
 *   quote:history:<phone>        — historial por paciente (max 30)
 *   quotes:replyTo:<chatId>      — modo respuesta de Andrea para paciente N
 */
import type { Context } from "hono";
import type { Env } from "./env";
import { sendText } from "./whatsapp";
import { isAllowed, getAllRecipients } from "./users";
import { setMode } from "./claudeAi";
import {
  downloadTelegramFile,
  uploadWAMedia,
  sendWAMedia,
} from "./whatsappMedia";

const API = (token: string) => `https://api.telegram.org/bot${token}`;

export type QuoteSource = "wa_ai" | "wa_doctor" | "manual";

export interface QuoteTicket {
  id: string;
  fromPhone: string;
  patientName: string;
  cedula?: string;
  source: QuoteSource;
  procedure?: string;        // p.ej. "rinoplastia"
  details?: string;          // info adicional (edad, antecedentes, etc.)
  patientMessage?: string;   // el último mensaje del paciente
  context?: string;          // contexto adicional (ej. "Dr. ya estaba respondiendo y delegó")
  createdAt: number;
  status: "pending" | "quoted" | "accepted" | "rejected" | "expired";
  quotedBy?: string;
  quotedAmount?: string;
  quotedAt?: number;
}

export interface QuoteHistoryEntry {
  ticketId: string;
  source: QuoteSource;
  procedure?: string;
  amount?: string;
  status: QuoteTicket["status"];
  at: number;
  quotedBy?: string;
}

const PENDING_KEY = "quote:pending:list";

// ====================================================================
// Public API: crear ticket + notificar a Andrea
// ====================================================================

export async function createQuoteTicket(
  env: Env,
  ticket: Omit<QuoteTicket, "id" | "createdAt" | "status">,
): Promise<QuoteTicket> {
  const newTicket: QuoteTicket = {
    ...ticket,
    id: cryptoRandomId(),
    createdAt: Date.now(),
    status: "pending",
  };

  // Append to queue (max 50)
  const raw = await env.STATE.get(PENDING_KEY);
  let list: QuoteTicket[] = [];
  if (raw) {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  list.push(newTicket);
  await env.STATE.put(PENDING_KEY, JSON.stringify(list.slice(-50)), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  // Notificar al bot de Andrea (si está configurado)
  await notifyAndrea(env, newTicket);

  return newTicket;
}

async function notifyAndrea(env: Env, t: QuoteTicket): Promise<boolean> {
  if (!env.TELEGRAM_QUOTES_BOT_TOKEN) {
    console.log("[quotes] no TELEGRAM_QUOTES_BOT_TOKEN, falling back to main bot");
    // Fallback: notify via main Telegram bot
    try {
      const recipients = await getAllRecipients(env);
      for (const chatId of recipients) {
        await fetch(`${API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: renderTicketHtml(t),
            parse_mode: "HTML",
          }),
        });
      }
    } catch (e) {
      console.log("[quotes] main-bot fallback notify failed:", (e as Error).message);
    }
    return false;
  }

  const recipients = await getAllRecipients(env);
  for (const chatId of recipients) {
    try {
      await fetch(`${API(env.TELEGRAM_QUOTES_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTicketHtml(t),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "💰 Enviar cotización", callback_data: `qr:${t.fromPhone}:${t.id}` },
                { text: "❓ Pedir más info", callback_data: `qi:${t.fromPhone}:${t.id}` },
              ],
              [
                { text: "📋 Ver historial", callback_data: `qh:${t.fromPhone}` },
                { text: "❌ Descartar", callback_data: `qx:${t.id}` },
              ],
              [
                { text: "🤖 Devolver a IA", callback_data: `qb:${t.fromPhone}` },
              ],
            ],
          },
        }),
      });
    } catch (e) {
      console.log(`[quotes] notify ${chatId} failed:`, (e as Error).message);
    }
  }
  return true;
}

function renderTicketHtml(t: QuoteTicket): string {
  const sourceLabel: Record<QuoteSource, string> = {
    wa_ai: "🤖 IA detectó intent",
    wa_doctor: "👨‍⚕️ Dr. delegó",
    manual: "✍️ manual",
  };
  const lines = [
    `💰 <b>Nueva solicitud de cotización</b>`,
    "",
    `Paciente: <b>${escapeHtml(t.patientName)}</b>` +
      (t.cedula ? ` (CC <code>${escapeHtml(t.cedula)}</code>)` : ""),
    `📞 <code>${escapeHtml(t.fromPhone)}</code>`,
    `Origen: ${sourceLabel[t.source]}`,
  ];
  if (t.procedure) lines.push(`Procedimiento: <b>${escapeHtml(t.procedure)}</b>`);
  if (t.details) lines.push(`Detalles: <i>${escapeHtml(t.details)}</i>`);
  if (t.patientMessage) {
    lines.push("", "━━━━━━━━━━");
    lines.push(`<b>Paciente dijo:</b> ${escapeHtml(t.patientMessage.slice(0, 400))}`);
    lines.push("━━━━━━━━━━");
  }
  if (t.context) {
    lines.push(`<i>${escapeHtml(t.context)}</i>`);
  }
  lines.push("", `<code>id: ${t.id}</code>`);
  return lines.join("\n");
}

// ====================================================================
// Webhook handler — bot de Andrea
// ====================================================================

export async function handleQuotesWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let update: any;
  try { update = await c.req.json(); } catch { return c.json({ ok: true }); }

  // ---- Callback buttons ----
  if (update.callback_query) {
    return await handleQuoteCallback(c, update.callback_query);
  }

  // ---- Media (photos, docs, voice, video) ----
  if (
    update.message?.photo ||
    update.message?.document ||
    update.message?.voice ||
    update.message?.audio ||
    update.message?.video
  ) {
    return await handleQuoteMedia(c, update);
  }

  // ---- Texto ----
  if (update.message?.text) {
    return await handleQuoteText(c, update);
  }

  return c.json({ ok: true });
}

async function handleQuoteCallback(c: Context<{ Bindings: Env }>, cb: any): Promise<Response> {
  const chatId = String(cb.from.id);
  const data: string = cb.data ?? "";
  if (!(await isAllowed(c.env, chatId))) {
    await answerQuoteCallback(c.env, cb.id, "No autorizado");
    return c.json({ ok: true });
  }

  if (data.startsWith("qr:")) {
    // qr:<phone>:<ticketId> → activa modo respuesta para esta cotización
    const rest = data.slice(3);
    const idx = rest.indexOf(":");
    const phone = rest.slice(0, idx);
    const ticketId = rest.slice(idx + 1);
    await c.env.STATE.put(`quotes:replyTo:${chatId}`, JSON.stringify({ phone, ticketId }), {
      expirationTtl: 60 * 30,
    });
    // ASSIGNEE: Andrea es la dueña de esta conversación. Mode manual + assignee=andrea
    // → mensajes del paciente se rutean a este bot, no al de handoff ni al principal.
    await assignToAndrea(c.env, phone);
    await answerQuoteCallback(c.env, cb.id, "💰 Modo cotización");
    await sendQuoteMessage(
      c.env,
      chatId,
      `💰 Modo cotización activo para <code>${phone}</code>.\nEscribe la cotización (incluye procedimiento, precio total, qué incluye, vigencia). Se enviará tal cual al WhatsApp.\n\n<i>También puedes mandar foto/PDF (factura, plan quirúrgico).</i>\n\nMientras estés en este modo, los mensajes que el paciente responda llegan AQUÍ.\n\n/cancelar para salir · /auto ${phone} para devolver a IA.`,
    );
    return c.json({ ok: true });
  }

  if (data.startsWith("qi:")) {
    // Pedir más info al paciente — preset de mensaje
    const rest = data.slice(3);
    const idx = rest.indexOf(":");
    const phone = rest.slice(0, idx);
    await c.env.STATE.put(`quotes:replyTo:${chatId}`, JSON.stringify({ phone, ticketId: rest.slice(idx + 1) }), {
      expirationTtl: 60 * 30,
    });
    await assignToAndrea(c.env, phone);
    await answerQuoteCallback(c.env, cb.id, "❓ Modo respuesta");
    await sendQuoteMessage(
      c.env,
      chatId,
      `❓ Pedir info a <code>${phone}</code>.\nEscribe qué necesitas saber (edad, antecedentes, exámenes, fecha deseada, etc.).\n\nMientras estés en este modo, los mensajes que el paciente responda llegan AQUÍ.`,
    );
    return c.json({ ok: true });
  }

  if (data.startsWith("qh:")) {
    const phone = data.slice(3);
    await answerQuoteCallback(c.env, cb.id, "");
    return await showQuoteHistory(c.env, chatId, phone);
  }

  if (data.startsWith("qx:")) {
    const ticketId = data.slice(3);
    await markTicketStatus(c.env, ticketId, "rejected");
    await answerQuoteCallback(c.env, cb.id, "❌ Descartado");
    await sendQuoteMessage(c.env, chatId, `❌ Ticket <code>${ticketId}</code> descartado. (No se notifica al paciente.)`);
    return c.json({ ok: true });
  }

  if (data.startsWith("qb:")) {
    // qb:<phone> → Andrea devuelve la conversación a la IA
    const phone = data.slice(3);
    await releaseAssignee(c.env, phone);
    await setMode(c.env, phone, "auto");
    await c.env.STATE.delete(`quotes:replyTo:${chatId}`);
    await answerQuoteCallback(c.env, cb.id, "🤖 Devuelto a IA");
    await sendQuoteMessage(c.env, chatId, `🤖 <code>${phone}</code> vuelve a modo IA. Próximos mensajes los maneja la AI.`);
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
}

async function handleQuoteMedia(c: Context<{ Bindings: Env }>, update: any): Promise<Response> {
  const chatId = String(update.message.chat.id);
  if (!(await isAllowed(c.env, chatId))) return c.json({ ok: true });
  const replyState = await readReplyState(c.env, chatId);
  if (!replyState) {
    await sendQuoteMessage(c.env, chatId, "❓ Toca '💰 Enviar cotización' o '❓ Pedir más info' en una alerta primero.");
    return c.json({ ok: true });
  }
  if (!c.env.TELEGRAM_QUOTES_BOT_TOKEN) {
    await sendQuoteMessage(c.env, chatId, "❌ Bot de cotizaciones sin token.");
    return c.json({ ok: true });
  }

  const caption = String(update.message.caption ?? "").trim();
  let result: { ok: boolean; data?: any } | null = null;
  try {
    if (update.message.photo) {
      const p = update.message.photo[update.message.photo.length - 1];
      const f = await downloadTelegramFile(c.env.TELEGRAM_QUOTES_BOT_TOKEN, p.file_id);
      if (!f) throw new Error("no se pudo descargar");
      const id = await uploadWAMedia(c.env, f.buffer, f.mimeType, f.filename);
      if (!id) throw new Error("no se pudo subir a WA");
      result = await sendWAMedia(c.env, replyState.phone, "image", id, caption);
    } else if (update.message.document) {
      const d = update.message.document;
      const f = await downloadTelegramFile(c.env.TELEGRAM_QUOTES_BOT_TOKEN, d.file_id);
      if (!f) throw new Error("no se pudo descargar documento");
      const fname = d.file_name ?? f.filename;
      const mime = d.mime_type ?? f.mimeType;
      const id = await uploadWAMedia(c.env, f.buffer, mime, fname);
      if (!id) throw new Error("no se pudo subir documento");
      result = await sendWAMedia(c.env, replyState.phone, "document", id, caption, fname);
    }
  } catch (e) {
    await sendQuoteMessage(c.env, chatId, `❌ ${escapeHtml((e as Error).message)}`);
    return c.json({ ok: true });
  }

  if (result?.ok) {
    await sendQuoteMessage(c.env, chatId, `✅ Enviado a <code>${replyState.phone}</code>`);
    await appendQuoteHistory(c.env, replyState.phone, {
      ticketId: replyState.ticketId,
      source: "manual",
      amount: caption || "(adjunto)",
      status: "quoted",
      at: Date.now(),
      quotedBy: chatId,
    });
    await markTicketStatus(c.env, replyState.ticketId, "quoted", chatId, caption);
  } else {
    await sendQuoteMessage(c.env, chatId, `❌ WhatsApp rechazó: ${escapeHtml(JSON.stringify(result?.data?.error ?? {}).slice(0, 200))}`);
  }
  return c.json({ ok: true });
}

async function handleQuoteText(c: Context<{ Bindings: Env }>, update: any): Promise<Response> {
  const text: string = String(update.message.text).trim();
  const chatId = String(update.message.chat.id);
  if (!(await isAllowed(c.env, chatId))) {
    await sendQuoteMessage(c.env, chatId, "🚫 No autorizado para usar este bot.");
    return c.json({ ok: true });
  }

  // POP CUC — agenda interna Clínica Colombia (sin notificación externa)
  {
    const { handlePopCuc } = await import("./popCuc");
    const userId = `tg:${chatId}`;
    const popResult = await handlePopCuc(c.env, userId, text);
    if (popResult) {
      await sendQuoteMessage(c.env, chatId, popResult.reply);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  }

  if (text === "/start" || text === "/help") {
    await sendQuoteMessage(c.env, chatId, [
      "👋 <b>Bot de cotizaciones — Andrea</b>",
      "",
      "Cuando un paciente pide cotización (vía AI o el Dr. te delega), te llega aquí. Toca <b>💰 Enviar cotización</b>, escribe el precio + lo que incluye, y se manda al WhatsApp.",
      "",
      "<b>Comandos:</b>",
      "<code>/cotizaciones</code> — pendientes en cola",
      "<code>/cotizar &lt;número&gt; &lt;texto/precio&gt;</code> — cotización rápida",
      "<code>/historial &lt;número o cédula&gt;</code> — ver cotizaciones previas",
      "<code>/cancelar</code> — salir del modo respuesta (sigues como dueña)",
      "<code>/auto &lt;número&gt;</code> — devolver conversación a la IA",
    ].join("\n"));
    return c.json({ ok: true });
  }

  if (text === "/cancelar" || text === "/cancel") {
    await c.env.STATE.delete(`quotes:replyTo:${chatId}`);
    await sendQuoteMessage(c.env, chatId, "❌ Modo respuesta cancelado. <i>(Andrea sigue como dueña de la conversación; usa /auto &lt;número&gt; para devolver a IA.)</i>");
    return c.json({ ok: true });
  }

  if (text.startsWith("/auto ")) {
    // /auto <número> → libera assignee + setea mode=auto + clear replyTo
    const numRaw = text.slice("/auto ".length).trim();
    const phone = numRaw.replace(/\D/g, "");
    if (phone.length < 10) {
      await sendQuoteMessage(c.env, chatId, "❌ Número inválido. Usa: <code>/auto 573204933887</code>");
      return c.json({ ok: true });
    }
    await releaseAssignee(c.env, phone);
    await setMode(c.env, phone, "auto");
    await c.env.STATE.delete(`quotes:replyTo:${chatId}`);
    await sendQuoteMessage(c.env, chatId, `🤖 <code>${phone}</code> vuelve a IA. Próximos mensajes los maneja la AI.`);
    return c.json({ ok: true });
  }

  if (text === "/cotizaciones" || text === "/pendientes") {
    return await showPendingQuotes(c.env, chatId);
  }

  if (text.startsWith("/cotizar ")) {
    return await handleCotizarCommand(c.env, chatId, text.slice("/cotizar ".length).trim());
  }

  if (text.startsWith("/historial ")) {
    const phone = text.slice("/historial ".length).trim().replace(/\D/g, "");
    return await showQuoteHistory(c.env, chatId, phone);
  }

  // Texto libre → si está en modo respuesta, relay
  const replyState = await readReplyState(c.env, chatId);
  if (replyState) {
    const r = await sendText(c.env, replyState.phone, text);
    if (r.ok) {
      await sendQuoteMessage(c.env, chatId, `✅ Enviado a <code>${replyState.phone}</code>\n<i>(modo sigue activo · /cancelar para salir)</i>`);
      await appendQuoteHistory(c.env, replyState.phone, {
        ticketId: replyState.ticketId,
        source: "manual",
        amount: text.slice(0, 200),
        status: "quoted",
        at: Date.now(),
        quotedBy: chatId,
      });
      await markTicketStatus(c.env, replyState.ticketId, "quoted", chatId, text);
    } else {
      const err = r.data?.error?.message ?? "?";
      await sendQuoteMessage(c.env, chatId, `❌ WA rechazó: ${escapeHtml(String(err))}\n<i>Probable fuera de ventana 24h. Necesitas template aprobado.</i>`);
    }
    return c.json({ ok: true });
  }

  await sendQuoteMessage(c.env, chatId, "❓ /help para ayuda. /cotizaciones para ver pendientes.");
  return c.json({ ok: true });
}

async function handleCotizarCommand(env: Env, chatId: string, args: string): Promise<Response> {
  // /cotizar <num> <texto libre>
  const m = args.match(/^(\+?\d{10,12})\s+([\s\S]+)$/);
  if (!m) {
    await sendQuoteMessage(env, chatId, "Uso: <code>/cotizar &lt;número&gt; &lt;cotización&gt;</code>\nEjemplo: <code>/cotizar 573204933887 Rinoplastia $12.000.000 incluye honorarios + clínica + anestesia. Vigencia 30 días.</code>");
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  const phone = m[1].replace(/\D/g, "");
  const message = m[2].trim();

  const ticket = await createQuoteTicket(env, {
    fromPhone: phone,
    patientName: "(manual)",
    source: "manual",
    patientMessage: message.slice(0, 400),
  });

  const r = await sendText(env, phone, message);
  if (r.ok) {
    await sendQuoteMessage(env, chatId, `✅ Cotización enviada a <code>${phone}</code>`);
    await appendQuoteHistory(env, phone, {
      ticketId: ticket.id,
      source: "manual",
      amount: message.slice(0, 200),
      status: "quoted",
      at: Date.now(),
      quotedBy: chatId,
    });
    await markTicketStatus(env, ticket.id, "quoted", chatId, message);
  } else {
    const err = r.data?.error?.message ?? "?";
    await sendQuoteMessage(env, chatId, `❌ Falló: ${escapeHtml(String(err))}`);
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}

async function showPendingQuotes(env: Env, chatId: string): Promise<Response> {
  const raw = await env.STATE.get(PENDING_KEY);
  if (!raw) {
    await sendQuoteMessage(env, chatId, "✅ Sin cotizaciones pendientes.");
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  let list: QuoteTicket[] = [];
  try { list = JSON.parse(raw); } catch { /* ignore */ }
  const pending = list.filter((t) => t.status === "pending");
  if (pending.length === 0) {
    await sendQuoteMessage(env, chatId, "✅ Sin cotizaciones pendientes.");
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  const lines = [`💰 <b>${pending.length} pendiente(s)</b>`, ""];
  for (const t of pending.slice(0, 10)) {
    const ago = Math.floor((Date.now() - t.createdAt) / 60000);
    lines.push(
      `• <b>${escapeHtml(t.patientName)}</b> — ${escapeHtml(t.procedure ?? "(sin proc)")}\n   📞 <code>${escapeHtml(t.fromPhone)}</code> · hace ${ago} min · <code>${t.id.slice(0, 8)}</code>`,
    );
  }
  await sendQuoteMessage(env, chatId, lines.join("\n\n"));
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}

async function showQuoteHistory(env: Env, chatId: string, phoneOrCedula: string): Promise<Response> {
  // Try as phone first
  const phone = phoneOrCedula.replace(/\D/g, "");
  const raw = await env.STATE.get(`quote:history:${phone}`);
  if (!raw) {
    await sendQuoteMessage(env, chatId, `📋 Sin historial de cotizaciones para <code>${escapeHtml(phone)}</code>.`);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  let hist: QuoteHistoryEntry[] = [];
  try { hist = JSON.parse(raw); } catch { /* ignore */ }
  if (hist.length === 0) {
    await sendQuoteMessage(env, chatId, `📋 Historial vacío.`);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  const lines = [`📋 <b>Historial cotizaciones — ${phone}</b>`, ""];
  for (const h of hist.slice(-10).reverse()) {
    const date = new Date(h.at).toLocaleString("es-CO", { timeZone: "America/Bogota", hour12: false });
    lines.push(
      `• ${date}\n   ${h.source} · ${escapeHtml(h.procedure ?? "")}` +
        (h.amount ? `\n   💰 ${escapeHtml(h.amount.slice(0, 200))}` : ""),
    );
  }
  await sendQuoteMessage(env, chatId, lines.join("\n\n"));
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}

// ====================================================================
// Helpers
// ====================================================================

async function readReplyState(env: Env, chatId: string): Promise<{ phone: string; ticketId: string } | null> {
  const raw = await env.STATE.get(`quotes:replyTo:${chatId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function appendQuoteHistory(env: Env, phone: string, entry: QuoteHistoryEntry): Promise<void> {
  const key = `quote:history:${phone}`;
  const raw = await env.STATE.get(key);
  let arr: QuoteHistoryEntry[] = [];
  if (raw) {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  arr.push(entry);
  await env.STATE.put(key, JSON.stringify(arr.slice(-30)), {
    expirationTtl: 60 * 60 * 24 * 365,
  });
}

async function markTicketStatus(
  env: Env,
  ticketId: string,
  status: QuoteTicket["status"],
  quotedBy?: string,
  amount?: string,
): Promise<void> {
  const raw = await env.STATE.get(PENDING_KEY);
  if (!raw) return;
  let list: QuoteTicket[] = [];
  try { list = JSON.parse(raw); } catch { /* ignore */ }
  const t = list.find((x) => x.id === ticketId);
  if (!t) return;
  t.status = status;
  if (quotedBy) t.quotedBy = quotedBy;
  if (amount) t.quotedAmount = amount.slice(0, 500);
  if (status === "quoted") t.quotedAt = Date.now();
  await env.STATE.put(PENDING_KEY, JSON.stringify(list), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
}

// ====================================================================
// Assignee tracking — quién es el dueño actual de una conversación WA
// ====================================================================
//   wa:assignee:{phone}  → "andrea" | "doctor" (vacío = AI)
// Se setea cuando Andrea o el doctor activan modo respuesta.
// Se limpia cuando devuelven a IA. TTL 24h por seguridad.

export async function assignToAndrea(env: Env, phone: string): Promise<void> {
  await env.STATE.put(`wa:assignee:${phone}`, "andrea", { expirationTtl: 60 * 60 * 24 });
  // También aseguramos que el contacto esté en mode=manual para que la IA no responda
  await setMode(env, phone, "manual");
}

export async function releaseAssignee(env: Env, phone: string): Promise<void> {
  await env.STATE.delete(`wa:assignee:${phone}`);
}

export async function getAssignee(env: Env, phone: string): Promise<"andrea" | "doctor" | null> {
  const v = await env.STATE.get(`wa:assignee:${phone}`);
  return (v as "andrea" | "doctor" | null) ?? null;
}

/**
 * Reenvía un mensaje del paciente al bot de cotizaciones (Andrea) cuando ella
 * es la dueña de la conversación. Mantiene el chat unificado en
 * @consultorioandrea_bot mientras dure su modo respuesta.
 *
 * Returns true si al menos un destinatario recibió el mensaje.
 */
export async function sendQuotePatientMessage(
  env: Env,
  opts: {
    fromPhone: string;
    patientName: string;
    text: string;
    label?: string;
  },
): Promise<boolean> {
  if (!env.TELEGRAM_QUOTES_BOT_TOKEN) return false;

  const label = opts.label ?? "💬";
  const lines = [
    `${label} <b>${escapeHtml(opts.patientName)}</b> · <code>${escapeHtml(opts.fromPhone)}</code>`,
    "",
    escapeHtml(opts.text),
  ];

  const recipients = await getAllRecipients(env);
  let anyDelivered = false;
  for (const chatId of recipients) {
    try {
      const res = await fetch(`${API(env.TELEGRAM_QUOTES_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: lines.join("\n"),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "💰 Responder cotización", callback_data: `qr:${opts.fromPhone}:reply` },
              { text: "🤖 Devolver a IA", callback_data: `qb:${opts.fromPhone}` },
            ]],
          },
        }),
      });
      if (res.ok) anyDelivered = true;
      else {
        const body = await res.text().catch(() => "");
        console.log(`[quotes] sendPatientMessage to ${chatId} failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`[quotes] sendPatientMessage to ${chatId} threw:`, (e as Error).message);
    }
  }
  return anyDelivered;
}

async function sendQuoteMessage(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_QUOTES_BOT_TOKEN) return;
  await fetch(`${API(env.TELEGRAM_QUOTES_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function answerQuoteCallback(env: Env, cbId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_QUOTES_BOT_TOKEN) return;
  await fetch(`${API(env.TELEGRAM_QUOTES_BOT_TOKEN)}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbId, text }),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cryptoRandomId(): string {
  // 8 hex chars — corto pero único enough para 30 días
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ====================================================================
// Setup webhook (one-time)
// ====================================================================

export async function setupQuotesWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!c.env.TELEGRAM_QUOTES_BOT_TOKEN) {
    return c.json({ error: "TELEGRAM_QUOTES_BOT_TOKEN no está seteado" }, 400);
  }
  const url = new URL(c.req.url);
  const webhookUrl = `${url.origin}/tg/quotes-webhook`;
  const res = await fetch(`${API(c.env.TELEGRAM_QUOTES_BOT_TOKEN)}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: c.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    }),
  });
  return c.json({ webhook: webhookUrl, telegram: await res.json() });
}
