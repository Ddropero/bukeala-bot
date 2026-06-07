/**
 * Telegram bot DEDICADO al handoff humano.
 *
 * Cuando la AI de WhatsApp determina que necesita un humano (queja, urgencia
 * médica, fuera de scope, etc.), no se notifica al bot principal — se notifica
 * a ESTE bot, que actúa como un puente WhatsApp ↔ Telegram en tiempo real.
 *
 * UX:
 *   1. Paciente WA escribe algo que la AI escala
 *   2. Este bot envía un mensaje al doctor con el contexto + 2 botones:
 *        [📤 Responder]  [🔚 Devolver a IA]
 *   3. Doctor toca "Responder" → se activa modo respuesta para ese paciente
 *      (TTL 30 min) → cualquier texto que escriba se envía al WhatsApp del
 *      paciente
 *   4. Doctor toca "Devolver a IA" → el contacto vuelve a modo auto, la AI
 *      retoma la conversación
 *   5. /cancelar sale del modo respuesta sin reenviar
 *
 * También soporta `/r <número> <mensaje>` para responder sin pasar por
 * el botón.
 *
 * IMPORTANTE: este bot solo funciona si se setea el secret
 * TELEGRAM_HANDOFF_BOT_TOKEN. Sin él, los escalations siguen llegando al bot
 * principal (fallback en whatsappWebhook.ts).
 */
import type { Context } from "hono";
import type { Env } from "./env";
import { sendText } from "./whatsapp";
import { setMode } from "./claudeAi";
import { getAllRecipients, isAllowed } from "./users";
import { downloadTelegramFile, uploadWAMedia, sendWAMedia } from "./whatsappMedia";
import { createQuoteTicket } from "./quotesBot";
import { appendHistory } from "./claudeAi";
import { forumEnabled, sendToTopic, phoneForTopic, closeTopic, reopenTopic } from "./forumTopics";

/**
 * Palabras clave que disparan delegación a Andrea cuando el doctor escribe
 * algo en el bot de handoff. Si el doctor escribe "te paso a andrea con la
 * cotización" o "te coordino el precio con Andrea", se interpreta como una
 * delegación explícita: el mensaje sigue yendo al paciente Y se crea un
 * ticket en el bot de cotizaciones.
 */
const QUOTE_TRIGGER_RE =
  /\b(cotizaci[oó]n|cotizar|precio|presupuesto|valor|costo|cu[áa]nto (cuesta|vale|sale)|tarifa)\b/i;

const HANDOFF_API = (token: string) => `https://api.telegram.org/bot${token}`;

export interface HandoffEscalation {
  fromPhone: string;
  patientName: string;
  message: string;        // Última cosa que escribió el paciente
  reason: string;         // Por qué se escala
  cedula?: string;
  aiReply?: string;       // Lo que la AI le respondió antes de escalar (si algo)
  intent?: string;        // Intent detectado por la IA (agendar, cancelar, queja...)
  urgency?: "alta" | "media" | "baja"; // Urgencia detectada por la IA
  suggestion?: string;    // Sugerencia de respuesta para el doctor
}

function intentEmoji(intent?: string): string {
  switch (intent) {
    case "agendar": return "📅";
    case "cancelar": return "❌";
    case "consulta_medica": return "🩺";
    case "queja": return "😡";
    case "informacion_general": return "ℹ️";
    case "otro": return "❓";
    default: return "🚨";
  }
}

function urgencyBadge(urgency?: string): string {
  switch (urgency) {
    case "alta": return "🔴 ALTA";
    case "media": return "🟡 MEDIA";
    case "baja": return "🟢 BAJA";
    default: return "";
  }
}

/**
 * Envía la alerta de escalación a TODOS los usuarios autorizados a través
 * del bot de handoff. Si el bot no está configurado, devuelve false (el
 * caller debe usar el bot principal como fallback).
 */
export async function sendHandoffNotification(
  env: Env,
  esc: HandoffEscalation,
): Promise<boolean> {
  if (!env.TELEGRAM_HANDOFF_BOT_TOKEN) {
    console.log("[handoff] no TELEGRAM_HANDOFF_BOT_TOKEN, falling back to main bot");
    return false;
  }

  const ie = intentEmoji(esc.intent);
  const ub = urgencyBadge(esc.urgency);
  const headerLine = `${ie} ${ub ? ub + " · " : ""}<b>${escapeHtml(esc.patientName)}</b>` +
    (esc.cedula ? ` (CC <code>${escapeHtml(esc.cedula)}</code>)` : "");

  const lines: string[] = [
    headerLine,
    `📞 <code>${escapeHtml(esc.fromPhone)}</code>`,
    "",
    "━━━━━━━━━━━━━",
    `<b>Paciente:</b> ${escapeHtml(esc.message)}`,
  ];
  if (esc.aiReply) {
    lines.push(`<b>IA respondió:</b> <i>${escapeHtml(esc.aiReply)}</i>`);
  }
  lines.push("━━━━━━━━━━━━━");
  lines.push("");
  lines.push(`<i>Razón escalación:</i> ${escapeHtml(esc.reason)}`);
  if (esc.intent) {
    lines.push("");
    lines.push(`<b>Intent:</b> ${escapeHtml(esc.intent)}`);
  }
  if (esc.suggestion) {
    lines.push(`<b>💡 Sugerencia:</b> <i>${escapeHtml(esc.suggestion)}</i>`);
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: "📤 Responder", callback_data: `hr:${esc.fromPhone}` },
        { text: "📜 Historial", callback_data: `hH:${esc.fromPhone}` },
      ],
      [
        { text: "🔚 Devolver a IA", callback_data: `hb:${esc.fromPhone}` },
      ],
    ],
  };

  // MODO FORUM: si hay grupo de temas, mandamos la alerta al HILO del paciente
  // (un chat propio por paciente). Reabrimos el hilo por si estaba cerrado.
  if (forumEnabled(env)) {
    await reopenTopic(env, esc.fromPhone);
    const ok = await sendToTopic(env, esc.fromPhone, esc.patientName, lines.join("\n"), keyboard);
    if (ok) return true;
    // si falló el forum, caemos al modo DM clásico abajo
    console.log("[handoff] forum send failed, fallback a DMs");
  }

  const recipients = await getAllRecipients(env);
  let anyDelivered = false;
  for (const chatId of recipients) {
    try {
      const res = await fetch(`${HANDOFF_API(env.TELEGRAM_HANDOFF_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: lines.join("\n"),
          parse_mode: "HTML",
          reply_markup: keyboard,
        }),
      });
      if (res.ok) anyDelivered = true;
      else {
        const body = await res.text().catch(() => "");
        console.log(`[handoff] sendMessage to ${chatId} failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`[handoff] notify to ${chatId} threw:`, (e as Error).message);
    }
  }
  return anyDelivered;
}

/**
 * Reenvía un mensaje del paciente al handoff bot (cuando contacto está en modo
 * MANUAL, para que la conversación quede UNIFICADA en consultadavid_bot, sin
 * quedar partida entre @agendadavid_bot (entrante) y @consultadavid_bot (saliente)).
 *
 * Diferente de sendHandoffNotification porque ESA es una alerta inicial con
 * intent/urgency. Esta es para mensajes continuos durante una conversación
 * en curso — más simple, menos visualmente "ruidosa".
 *
 * Returns true si al menos un destinatario recibió el mensaje.
 */
export async function sendHandoffPatientMessage(
  env: Env,
  opts: {
    fromPhone: string;
    patientName: string;
    text: string;
    label?: string; // "💬" por defecto, "🎙️📝" si transcribed audio, etc.
  },
): Promise<boolean> {
  if (!env.TELEGRAM_HANDOFF_BOT_TOKEN) return false;

  const label = opts.label ?? "💬";
  const lines = [
    `${label} <b>${escapeHtml(opts.patientName)}</b> · <code>${escapeHtml(opts.fromPhone)}</code>`,
    "",
    escapeHtml(opts.text),
  ];

  // MODO FORUM: mensaje al hilo del paciente. En el hilo no hace falta el
  // botón "Responder" — basta con escribir dentro del hilo (lo maneja el
  // webhook). Igual dejamos "Devolver a IA" por comodidad.
  if (forumEnabled(env)) {
    const kb = { inline_keyboard: [[{ text: "🔚 Devolver a IA", callback_data: `hb:${opts.fromPhone}` }]] };
    const ok = await sendToTopic(env, opts.fromPhone, opts.patientName, lines.join("\n"), kb);
    if (ok) return true;
    console.log("[handoff] forum patient-msg failed, fallback a DMs");
  }

  const recipients = await getAllRecipients(env);
  let anyDelivered = false;
  for (const chatId of recipients) {
    try {
      const res = await fetch(`${HANDOFF_API(env.TELEGRAM_HANDOFF_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: lines.join("\n"),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "📤 Responder", callback_data: `hr:${opts.fromPhone}` },
              { text: "🔚 Devolver a IA", callback_data: `hb:${opts.fromPhone}` },
            ]],
          },
        }),
      });
      if (res.ok) anyDelivered = true;
      else {
        const body = await res.text().catch(() => "");
        console.log(`[handoff] sendPatientMessage to ${chatId} failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`[handoff] sendPatientMessage to ${chatId} threw:`, (e as Error).message);
    }
  }
  return anyDelivered;
}

/**
 * Webhook handler del bot de handoff. Telegram POST aquí cuando hay
 * mensajes o callbacks.
 */
export async function handleHandoffWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Auth: Telegram nos manda el secret en el header
  if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let update: any;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: true });
  }

  // ---- Captura del ID de grupo (setup de Forum Topics) ----
  // Cuando alguien escribe en un grupo/supergrupo donde está este bot,
  // guardamos el chat.id en KV para que el doctor pueda configurarlo como
  // TELEGRAM_HANDOFF_GROUP_ID. Se sobreescribe con cada mensaje de grupo.
  {
    const ct = update.message?.chat?.type || update.my_chat_member?.chat?.type;
    const cid = update.message?.chat?.id ?? update.my_chat_member?.chat?.id;
    const ctitle = update.message?.chat?.title ?? update.my_chat_member?.chat?.title ?? "";
    if ((ct === "group" || ct === "supergroup") && cid) {
      await c.env.STATE.put(
        "forum:lastGroupSeen",
        JSON.stringify({ id: cid, title: ctitle, at: new Date().toISOString() }),
        { expirationTtl: 60 * 30 },
      );
      console.log(`[handoff] grupo visto: ${cid} "${ctitle}"`);
    }
  }

  // ---- Callback button press ----
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String(cb.from.id);
    const data: string = cb.data || "";

    // ACL: el bot acepta callbacks solo de usuarios autorizados
    if (!(await isAllowed(c.env, chatId))) {
      await answerCallback(c.env, cb.id, "No autorizado");
      return c.json({ ok: true });
    }

    if (data.startsWith("hr:")) {
      const phone = data.slice(3);
      await c.env.STATE.put(`handoff:replyTo:${chatId}`, phone, { expirationTtl: 60 * 30 });
      // ASSIGNEE: doctor toma control. Mode manual + assignee=doctor → próximos
      // mensajes del paciente se rutean a este bot (no al de andrea ni al principal).
      await c.env.STATE.put(`wa:assignee:${phone}`, "doctor", { expirationTtl: 60 * 60 * 24 });
      await setMode(c.env, phone, "manual");
      await answerCallback(c.env, cb.id, "✏️ Modo respuesta activado");

      // Dump del historial completo para que el doctor tenga contexto
      await dumpHistoryToChat(c.env, chatId, phone);

      await sendHandoffMessage(
        c.env,
        chatId,
        `✏️ Modo respuesta activo para <code>${phone}</code>.\nEscribe lo que quieres mandarle al paciente — se envía por WhatsApp.\n\nLa conversación queda en MANUAL aquí hasta que toques <b>🔚 Devolver a IA</b>.\n\n/cancelar para salir sin enviar.`,
      );
      return c.json({ ok: true });
    }
    if (data.startsWith("hH:")) {
      // Solo ver historial (sin activar modo respuesta)
      const phone = data.slice(3);
      await answerCallback(c.env, cb.id, "📜 Historial");
      await dumpHistoryToChat(c.env, chatId, phone);
      return c.json({ ok: true });
    }
    if (data.startsWith("hb:")) {
      const phone = data.slice(3);
      await setMode(c.env, phone, "auto");
      await c.env.STATE.delete(`handoff:replyTo:${chatId}`);
      // ASSIGNEE: liberar — vuelve a IA
      await c.env.STATE.delete(`wa:assignee:${phone}`);
      await answerCallback(c.env, cb.id, "🤖 Devuelto a IA");
      // En modo forum, cerrar (archivar) el hilo del paciente + avisar dentro.
      if (forumEnabled(c.env)) {
        await sendToTopic(c.env, phone, "", "🤖 Devuelto a la IA. La asistente retoma la conversación.");
        await closeTopic(c.env, phone);
      } else {
        await sendHandoffMessage(
          c.env,
          chatId,
          `🤖 <code>${phone}</code> vuelve a modo IA. La AI retoma la conversación.`,
        );
      }
      return c.json({ ok: true });
    }
    return c.json({ ok: true });
  }

  // ---- Media del doctor (photo/document/audio/video) → reenviar al WA ----
  if (
    update.message?.photo ||
    update.message?.document ||
    update.message?.voice ||
    update.message?.audio ||
    update.message?.video
  ) {
    const chatId = String(update.message.chat.id);
    if (!(await isAllowed(c.env, chatId))) {
      await sendHandoffMessage(c.env, chatId, "🚫 No autorizado.");
      return c.json({ ok: true });
    }
    const replyTo = await c.env.STATE.get(`handoff:replyTo:${chatId}`);
    if (!replyTo) {
      await sendHandoffMessage(
        c.env,
        chatId,
        "❓ Toca '📤 Responder' en una alerta primero, o usa /r &lt;número&gt; antes de mandar la foto.",
      );
      return c.json({ ok: true });
    }
    if (!c.env.TELEGRAM_HANDOFF_BOT_TOKEN) {
      await sendHandoffMessage(c.env, chatId, "❌ Bot de handoff sin token configurado.");
      return c.json({ ok: true });
    }

    const caption = String(update.message.caption ?? "").trim();
    let result: { ok: boolean; status?: number; data?: any } | null = null;

    try {
      if (update.message.photo) {
        // Telegram envía varias resoluciones, usar la más grande
        const photos: any[] = update.message.photo;
        const largest = photos[photos.length - 1];
        const file = await downloadTelegramFile(c.env.TELEGRAM_HANDOFF_BOT_TOKEN, largest.file_id);
        if (!file) throw new Error("no se pudo descargar de Telegram");
        const mediaId = await uploadWAMedia(c.env, file.buffer, file.mimeType, file.filename);
        if (!mediaId) throw new Error("no se pudo subir a WhatsApp");
        result = await sendWAMedia(c.env, replyTo, "image", mediaId, caption);
      } else if (update.message.document) {
        const file = await downloadTelegramFile(c.env.TELEGRAM_HANDOFF_BOT_TOKEN, update.message.document.file_id);
        if (!file) throw new Error("no se pudo descargar documento");
        const filename = update.message.document.file_name ?? file.filename;
        const mime = update.message.document.mime_type ?? file.mimeType;
        const mediaId = await uploadWAMedia(c.env, file.buffer, mime, filename);
        if (!mediaId) throw new Error("no se pudo subir documento a WhatsApp");
        result = await sendWAMedia(c.env, replyTo, "document", mediaId, caption, filename);
      } else if (update.message.voice) {
        const file = await downloadTelegramFile(c.env.TELEGRAM_HANDOFF_BOT_TOKEN, update.message.voice.file_id);
        if (!file) throw new Error("no se pudo descargar audio");
        const mediaId = await uploadWAMedia(c.env, file.buffer, "audio/ogg; codecs=opus", "voice.ogg");
        if (!mediaId) throw new Error("no se pudo subir audio a WhatsApp");
        result = await sendWAMedia(c.env, replyTo, "audio", mediaId);
      } else if (update.message.audio) {
        const file = await downloadTelegramFile(c.env.TELEGRAM_HANDOFF_BOT_TOKEN, update.message.audio.file_id);
        if (!file) throw new Error("no se pudo descargar audio");
        const mime = update.message.audio.mime_type ?? "audio/mpeg";
        const mediaId = await uploadWAMedia(c.env, file.buffer, mime, "audio.mp3");
        if (!mediaId) throw new Error("no se pudo subir audio a WhatsApp");
        result = await sendWAMedia(c.env, replyTo, "audio", mediaId);
      } else if (update.message.video) {
        const file = await downloadTelegramFile(c.env.TELEGRAM_HANDOFF_BOT_TOKEN, update.message.video.file_id);
        if (!file) throw new Error("no se pudo descargar video");
        const mediaId = await uploadWAMedia(c.env, file.buffer, "video/mp4", "video.mp4");
        if (!mediaId) throw new Error("no se pudo subir video a WhatsApp");
        result = await sendWAMedia(c.env, replyTo, "video", mediaId, caption);
      }
    } catch (e) {
      await sendHandoffMessage(c.env, chatId, `❌ Error: ${escapeHtml((e as Error).message)}`);
      return c.json({ ok: true });
    }

    if (result?.ok) {
      // Marcador en el historial para context (cuando se devuelva a IA)
      const mediaMarker = caption
        ? `[Multimedia enviada por el equipo: ${caption.slice(0, 200)}]`
        : `[Multimedia enviada por el equipo]`;
      try { await appendHistory(c.env, replyTo, "assistant", mediaMarker, "wa"); } catch { /* ignore */ }
      await sendHandoffMessage(
        c.env,
        chatId,
        `✅ Enviado a <code>${replyTo}</code>` +
          (caption ? `\n<i>caption: ${escapeHtml(caption)}</i>` : ""),
      );
    } else {
      const errMsg = result?.data?.error?.message ?? `HTTP ${result?.status ?? "?"}`;
      await sendHandoffMessage(c.env, chatId, `❌ WhatsApp rechazó: ${escapeHtml(String(errMsg))}\n<i>Probable que esté fuera de ventana 24h.</i>`);
    }
    return c.json({ ok: true });
  }

  // ---- FORUM: texto escrito DENTRO de un hilo del grupo de pacientes ----
  // En un grupo, chat.id es el grupo (no la persona). Validamos al autor con
  // from.id, ubicamos el paciente por el message_thread_id, y reenviamos a su
  // WhatsApp. Cero comandos: el doctor solo escribe en el hilo.
  if (
    forumEnabled(c.env) &&
    update.message?.text &&
    String(update.message.chat?.id) === String((c.env as any).TELEGRAM_HANDOFF_GROUP_ID) &&
    update.message.message_thread_id
  ) {
    const grpChatId = String(update.message.chat.id);
    const threadId = Number(update.message.message_thread_id);
    const authorId = String(update.message.from?.id ?? "");
    const text = String(update.message.text).trim();

    // Ignorar comandos slash y mensajes de servicio dentro del hilo
    if (text.startsWith("/")) return c.json({ ok: true });

    // ACL por AUTOR (no por chat de grupo)
    if (!(await isAllowed(c.env, authorId))) {
      return c.json({ ok: true }); // silencio: no spamear el grupo
    }

    const phone = await phoneForTopic(c.env, threadId);
    if (!phone) {
      // Hilo sin paciente mapeado (ej. "General") — ignorar
      return c.json({ ok: true });
    }

    const r = await sendText(c.env, phone, text);
    if (r.ok) {
      await appendHistory(c.env, phone, "assistant", text, "wa");
      // Asegurar modo manual mientras el doctor conversa por el hilo
      await c.env.STATE.put(`wa:assignee:${phone}`, "doctor", { expirationTtl: 60 * 60 * 24 });
      await setMode(c.env, phone, "manual");
      // Acuse discreto: una reacción ✅ en el hilo (vía sendMessage corto)
      await fetch(`${HANDOFF_API(c.env.TELEGRAM_HANDOFF_BOT_TOKEN!)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: grpChatId,
          message_thread_id: threadId,
          text: "✅ enviado",
          disable_notification: true,
        }),
      });

      // Delegar a Andrea si menciona cotización (igual que en DM)
      if (QUOTE_TRIGGER_RE.test(text)) {
        try {
          const contactRaw = await c.env.STATE.get(`wa:contact:${phone}`);
          let patientName = "(sin nombre)";
          if (contactRaw) { try { patientName = JSON.parse(contactRaw).name ?? patientName; } catch { /* ignore */ } }
          const patCtxRaw = await c.env.STATE.get(`wa:patientCtx:${phone}`);
          let cedula: string | undefined;
          if (patCtxRaw) { try { cedula = JSON.parse(patCtxRaw).cedula; } catch { /* ignore */ } }
          await createQuoteTicket(c.env, {
            fromPhone: phone, patientName, cedula, source: "wa_doctor",
            patientMessage: text.slice(0, 400),
            context: `Dr. mencionó cotización en hilo: "${text.slice(0, 200)}"`,
          });
        } catch (e) { console.log("[forum] quote-trigger failed:", (e as Error).message); }
      }
    } else {
      const errMsg = r.data?.error?.message ?? "error desconocido";
      await fetch(`${HANDOFF_API(c.env.TELEGRAM_HANDOFF_BOT_TOKEN!)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: grpChatId, message_thread_id: threadId,
          text: `❌ No se pudo enviar: ${escapeHtml(String(errMsg))} (¿fuera de ventana 24h?)`,
        }),
      });
    }
    return c.json({ ok: true });
  }

  // ---- Mensajes de texto del doctor (DM clásico) ----
  if (update.message?.text) {
    const text: string = String(update.message.text).trim();
    const chatId = String(update.message.chat.id);

    // ACL
    if (!(await isAllowed(c.env, chatId))) {
      await sendHandoffMessage(
        c.env,
        chatId,
        "🚫 No estás autorizado para usar este bot. Pide acceso al doctor.",
      );
      return c.json({ ok: true });
    }

    // POP CUC — agenda interna Clínica Colombia (sin notificación externa)
    {
      const { handlePopCuc } = await import("./popCuc");
      const userId = `tg:${chatId}`;
      const popResult = await handlePopCuc(c.env, userId, text);
      if (popResult) {
        await sendHandoffMessage(c.env, chatId, popResult.reply);
        return c.json({ ok: true });
      }
    }

    if (text === "/start" || text === "/help") {
      await sendHandoffMessage(
        c.env,
        chatId,
        [
          "👋 <b>Bot de respuesta humana</b>",
          "",
          "Cuando la IA escala, te llega aquí un alerta. Toca <b>📤 Responder</b> y escribe tu mensaje — se reenvía al paciente por WhatsApp.",
          "",
          "También puedes usar:",
          "<code>/r &lt;número&gt; &lt;mensaje&gt;</code> — responder en una línea sin tocar botones",
          "<code>/cancelar</code> — salir del modo respuesta",
          "<code>/auto &lt;número&gt;</code> — devolver a IA",
        ].join("\n"),
      );
      return c.json({ ok: true });
    }

    if (text === "/cancelar" || text === "/cancel") {
      const had = await c.env.STATE.get(`handoff:replyTo:${chatId}`);
      await c.env.STATE.delete(`handoff:replyTo:${chatId}`);
      await sendHandoffMessage(
        c.env,
        chatId,
        had ? "❌ Modo respuesta cancelado." : "ℹ️ No estabas en modo respuesta.",
      );
      return c.json({ ok: true });
    }

    if (text.startsWith("/auto ")) {
      const numRaw = text.slice("/auto ".length).trim();
      const phone = numRaw.replace(/\D/g, "");
      if (phone.length < 10) {
        await sendHandoffMessage(c.env, chatId, "❌ Número inválido.");
        return c.json({ ok: true });
      }
      await setMode(c.env, phone, "auto");
      await sendHandoffMessage(c.env, chatId, `🤖 <code>${phone}</code> vuelve a IA.`);
      return c.json({ ok: true });
    }

    if (text.startsWith("/r ")) {
      const m = text.slice(3).match(/^(\+?\d{10,12})\s+([\s\S]+)$/);
      if (!m) {
        await sendHandoffMessage(c.env, chatId, "Uso: <code>/r &lt;número&gt; &lt;texto&gt;</code>");
        return c.json({ ok: true });
      }
      const phone = m[1].replace(/\D/g, "");
      const reply = m[2].trim();
      const r = await sendText(c.env, phone, reply);
      if (r.ok) {
        await appendHistory(c.env, phone, "assistant", reply, "wa");
        await sendHandoffMessage(c.env, chatId, `✅ Enviado a <code>${phone}</code>`);
      } else {
        const errMsg = r.data?.error?.message ?? "error desconocido";
        await sendHandoffMessage(c.env, chatId, `❌ Falló: ${escapeHtml(String(errMsg))}`);
      }
      return c.json({ ok: true });
    }

    // Texto libre → relay si está en modo respuesta
    const replyToPhone = await c.env.STATE.get(`handoff:replyTo:${chatId}`);
    if (replyToPhone) {
      const r = await sendText(c.env, replyToPhone, text);
      if (r.ok) {
        // Guardar la respuesta del doctor en el historial para que cuando
        // se devuelva a IA tenga contexto de la conversación manual.
        await appendHistory(c.env, replyToPhone, "assistant", text, "wa");
        await sendHandoffMessage(
          c.env,
          chatId,
          `✅ Enviado a <code>${replyToPhone}</code>\n<i>(sigues en modo respuesta · /cancelar para salir)</i>`,
        );

        // Si el mensaje del doctor menciona cotización/precio, también delegar a Andrea.
        if (QUOTE_TRIGGER_RE.test(text)) {
          try {
            const contactRaw = await c.env.STATE.get(`wa:contact:${replyToPhone}`);
            let patientName = "(sin nombre)";
            if (contactRaw) {
              try {
                const ct = JSON.parse(contactRaw);
                if (ct.name) patientName = ct.name;
              } catch { /* ignore */ }
            }
            const patCtxRaw = await c.env.STATE.get(`wa:patientCtx:${replyToPhone}`);
            let cedula: string | undefined;
            if (patCtxRaw) {
              try { cedula = JSON.parse(patCtxRaw).cedula; } catch { /* ignore */ }
            }
            await createQuoteTicket(c.env, {
              fromPhone: replyToPhone,
              patientName,
              cedula,
              source: "wa_doctor",
              patientMessage: text.slice(0, 400),
              context: `Dr. mencionó cotización mientras respondía en handoff: "${text.slice(0, 200)}"`,
            });
            await sendHandoffMessage(
              c.env,
              chatId,
              `🔔 También notifiqué a Andrea — verá la solicitud en su bot de cotizaciones.`,
            );
          } catch (e) {
            console.log("[handoff] quote-trigger failed:", (e as Error).message);
          }
        }
      } else {
        const errMsg = r.data?.error?.message ?? "error desconocido";
        await sendHandoffMessage(c.env, chatId, `❌ Falló: ${escapeHtml(String(errMsg))}`);
      }
      return c.json({ ok: true });
    }

    await sendHandoffMessage(
      c.env,
      chatId,
      "❓ No estás respondiendo a ningún paciente. Espera una escalación o usa <code>/r &lt;número&gt; &lt;texto&gt;</code>.",
    );
  }

  return c.json({ ok: true });
}

async function sendHandoffMessage(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_HANDOFF_BOT_TOKEN) return;
  await fetch(`${HANDOFF_API(env.TELEGRAM_HANDOFF_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

/**
 * Dump del historial completo de una conversación WA al chat del doctor.
 * Útil cuando toma control para tener TODO el contexto previo.
 */
async function dumpHistoryToChat(env: Env, chatId: string, phone: string): Promise<void> {
  const raw = await env.STATE.get(`wa:history:${phone}`);
  let hist: Array<{ role: string; content: string }> = [];
  if (raw) {
    try { hist = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (hist.length === 0) {
    await sendHandoffMessage(env, chatId, `📜 Sin historial guardado para <code>${phone}</code>.`);
    return;
  }
  // Nombre del paciente
  const contactRaw = await env.STATE.get(`wa:contact:${phone}`);
  let name = "(sin nombre)";
  if (contactRaw) {
    try { name = JSON.parse(contactRaw).name ?? name; } catch { /* ignore */ }
  }

  const lines: string[] = [
    `📜 <b>Historial conversación con ${escapeHtml(name)}</b>`,
    `📞 <code>${escapeHtml(phone)}</code> · ${hist.length} turnos`,
    "━━━━━━━━━━━━━",
    "",
  ];
  for (const t of hist) {
    const role = t.role === "user" ? "👤" : "🤖";
    const content = (t.content ?? "").toString();
    // Limitar cada turno a 400 chars para que el dump no rompa los 4096 de TG
    const trunc = content.length > 400 ? content.slice(0, 400) + "…" : content;
    lines.push(`${role} ${escapeHtml(trunc)}`);
  }

  // Telegram limita mensajes a 4096 chars. Si el historial es muy largo,
  // troceamos en varios mensajes.
  const fullText = lines.join("\n\n");
  const MAX = 3800;
  if (fullText.length <= MAX) {
    await sendHandoffMessage(env, chatId, fullText);
    return;
  }
  // Trocear por turnos hasta no exceder MAX por mensaje
  let buffer = lines.slice(0, 4).join("\n"); // header
  for (let i = 4; i < lines.length; i++) {
    const next = lines[i];
    if ((buffer + "\n\n" + next).length > MAX) {
      await sendHandoffMessage(env, chatId, buffer);
      buffer = next;
    } else {
      buffer = buffer ? buffer + "\n\n" + next : next;
    }
  }
  if (buffer) await sendHandoffMessage(env, chatId, buffer);
}

async function answerCallback(env: Env, cbId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_HANDOFF_BOT_TOKEN) return;
  await fetch(`${HANDOFF_API(env.TELEGRAM_HANDOFF_BOT_TOKEN)}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbId, text }),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Setup endpoint: registra el webhook del bot de handoff.
 * Llamar manualmente UNA VEZ después de setear el secret:
 *   curl https://<worker>.workers.dev/tg/handoff-setup?token=<CAPTURE_TOKEN>
 */
export async function setupHandoffWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!c.env.TELEGRAM_HANDOFF_BOT_TOKEN) {
    return c.json({ error: "TELEGRAM_HANDOFF_BOT_TOKEN no está seteado. Corre: wrangler secret put TELEGRAM_HANDOFF_BOT_TOKEN" }, 400);
  }
  const url = new URL(c.req.url);
  const webhookUrl = `${url.origin}/tg/handoff-webhook`;
  const res = await fetch(`${HANDOFF_API(c.env.TELEGRAM_HANDOFF_BOT_TOKEN)}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: c.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    }),
  });
  const data = await res.json();
  return c.json({ webhook: webhookUrl, telegram: data });
}
