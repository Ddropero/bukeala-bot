/**
 * WhatsApp Cloud API webhook handler.
 *
 * Meta sends:
 *   GET  /wa/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 *        → must echo back hub.challenge if verify_token matches.
 *
 *   POST /wa/webhook
 *        → JSON payload with incoming messages, statuses, etc.
 *
 * Inbound message flow (depends on per-contact mode in KV):
 *   - "manual" (default): forward to Telegram with inline keyboard
 *     [✅ Sugerir con Claude] [🤖 Auto ON] [📋 Hist].
 *     Doctor uses /wa_reply to answer.
 *   - "review": call Claude → send draft to Telegram with inline keyboard
 *     [✅ Enviar tal cual] [✏️ Editar] [🤖 Auto ON].
 *   - "auto": Claude responds directly. If Claude returns [ESCALAR],
 *     fallback to "review" for that turn.
 */
import type { Context } from "hono";
import type { Env } from "../env";
import { sendText, sendInteractiveButtons } from "../whatsapp";
import { suggestReply, appendHistory, getMode, setMode, type WaMode } from "../claudeAi";
import { runBookingAgent } from "../claudeBookingAgent";
import { getAllRecipients } from "../users";
import { sendHandoffNotification, sendHandoffPatientMessage } from "../handoffBot";
import { sendQuotePatientMessage, getAssignee } from "../quotesBot";
import {
  downloadWAMedia,
  sendTelegramPhoto,
  sendTelegramDocument,
  sendTelegramVoice,
  sendTelegramVideo,
} from "../whatsappMedia";
import { transcribeAudio } from "../whisper";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

interface WAWebhookEntry {
  changes?: Array<{
    field?: string;
    value?: {
      messaging_product?: string;
      metadata?: { display_phone_number?: string; phone_number_id?: string };
      contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
      messages?: Array<{
        from?: string;
        id?: string;
        timestamp?: string;
        type?: string;
        text?: { body?: string };
        button?: { text?: string; payload?: string };
        interactive?: {
          type?: string;
          button_reply?: { id?: string; title?: string };
          list_reply?: { id?: string; title?: string };
        };
        image?: { id?: string; mime_type?: string; sha256?: string; caption?: string };
        document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
        audio?: { id?: string; mime_type?: string; voice?: boolean };
        video?: { id?: string; mime_type?: string; caption?: string };
        sticker?: { id?: string; mime_type?: string; animated?: boolean };
      }>;
      statuses?: Array<{
        id?: string;
        status?: string;
        recipient_id?: string;
        errors?: Array<{ code?: number; title?: string; message?: string }>;
      }>;
    };
  }>;
}

interface WAWebhookPayload {
  object?: string;
  entry?: WAWebhookEntry[];
}

/**
 * Verify webhook (GET). Meta calls this once when you set up the webhook URL
 * in the App Dashboard. Echo back `hub.challenge` if `hub.verify_token` matches.
 */
export async function verifyWhatsAppWebhook(c: Context<{ Bindings: Env }>) {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge") ?? "";

  if (mode === "subscribe" && token === c.env.WA_VERIFY_TOKEN) {
    console.log("[wa-webhook] verified ok");
    return c.text(challenge, 200);
  }
  console.log("[wa-webhook] verify failed", { mode, tokenMatches: token === c.env.WA_VERIFY_TOKEN });
  return c.text("forbidden", 403);
}

/**
 * Handle incoming events (POST). Forward messages to Telegram immediately
 * (so doctor sees them) and ack 200 to Meta.
 */
export async function handleWhatsAppWebhook(c: Context<{ Bindings: Env }>) {
  let payload: WAWebhookPayload = {};
  try {
    payload = await c.req.json<WAWebhookPayload>();
  } catch (e) {
    console.log("[wa-webhook] invalid json", (e as Error).message);
    return c.json({ ok: true }); // ack anyway, don't make Meta retry
  }

  c.executionCtx.waitUntil(
    processPayload(c.env, payload).catch((err) => {
      console.error("[wa-webhook] processing failed", err);
    }),
  );

  // Always 200 — Meta retries non-200 aggressively, which can spam us.
  return c.json({ ok: true });
}

async function processPayload(env: Env, payload: WAWebhookPayload): Promise<void> {
  if (payload.object !== "whatsapp_business_account") return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      // 1) Inbound messages
      for (const msg of value.messages ?? []) {
        await handleInboundMessage(env, msg, value);
      }
      // 2) Status updates (delivered, read, failed)
      for (const status of value.statuses ?? []) {
        await handleStatusUpdate(env, status);
      }
    }
  }
}

async function handleInboundMessage(
  env: Env,
  msg: NonNullable<NonNullable<NonNullable<WAWebhookEntry["changes"]>[number]["value"]>["messages"]>[number],
  ctx: NonNullable<WAWebhookEntry["changes"]>[number]["value"],
): Promise<void> {
  const from = msg.from ?? "";
  const senderName = ctx?.contacts?.[0]?.profile?.name ?? "Desconocido";

  // ---- Handle interactive button replies (consent) ----
  // These come BEFORE we extract text, since they have a special structure.
  if (msg.type === "interactive" && msg.interactive?.button_reply) {
    const buttonId = msg.interactive.button_reply.id ?? "";
    if (buttonId === "consent_ai") {
      await env.STATE.put(`wa:consent:${from}`, "ai", { expirationTtl: 60 * 60 * 24 * 365 });
      await setMode(env, from, "auto");
      try {
        await sendText(
          env,
          from,
          "✅ Genial, te ayudaré con el asistente AI. Cuéntame, ¿qué necesitas? Por ejemplo: \"Quiero agendar una cita\" o \"¿Cuándo es mi próxima cita?\"",
        );
      } catch { /* ignore */ }
      console.log(`[wa-webhook] consent=ai from=${from}`);
      return;
    }
    if (buttonId === "consent_human") {
      await env.STATE.put(`wa:consent:${from}`, "human", { expirationTtl: 60 * 60 * 24 * 365 });
      await setMode(env, from, "manual");
      try {
        await sendText(
          env,
          from,
          "👤 Perfecto. Un asistente humano te responderá en breve. Por favor escribe tu consulta.",
        );
      } catch { /* ignore */ }
      // (continúa abajo)
      // Notify Telegram so doctor/secretary knows there's an active human-mode contact
      const escapedName = escapeHtml(senderName);
      await sendTelegram(
        env,
        `👤 <b>Nuevo paciente</b> <b>${escapedName}</b> (<code>${from}</code>) eligió <b>hablar con humano</b>. Próximos mensajes te llegarán aquí en modo manual.`,
        modeKeyboardManual(from),
      );
      console.log(`[wa-webhook] consent=human from=${from}`);
      return;
    }
  }

  // ---- Confirmación de cita: botón Quick Reply del template `confirmar_cita` ----
  // Los botones de respuesta rápida de un TEMPLATE llegan como type="button"
  // con button.text / button.payload (NO como interactive.button_reply).
  if (msg.type === "button" && msg.button) {
    const btn = `${msg.button.payload ?? ""} ${msg.button.text ?? ""}`.toLowerCase();
    const saysNo = /no\s*pod|no\s*asist|no\s*puedo|cancel/.test(btn);
    const saysYes = !saysNo && /confirm|s[ií]\b|asist|s[ií],|de acuerdo|ok/.test(btn);
    if (saysYes || saysNo) {
      await handleConfirmReply(env, from, senderName, saysYes);
      return;
    }
  }

  // ---- AUDIO/VOICE: transcribir con Whisper y procesar como texto ----
  // Esto permite que la AI siga manejando la conversación aunque el paciente
  // mande nota de voz. Mucho más útil que forzar manual mode.
  let injectedText = "";
  let isTranscribedAudio = false;
  if ((msg.type === "audio" && msg.audio?.id) && from) {
    const audioId = msg.audio.id;
    console.log(`[wa-webhook] inbound audio id=${audioId} from=${from} → transcribing`);
    const media = await downloadWAMedia(env, audioId);
    if (media) {
      const transcript = await transcribeAudio(env, media.buffer);
      if (transcript) {
        injectedText = transcript;
        isTranscribedAudio = true;

        // Push original audio + transcript a Telegram para visibilidad humana
        const handoffToken = env.TELEGRAM_HANDOFF_BOT_TOKEN;
        const targetToken = handoffToken || env.TELEGRAM_BOT_TOKEN;
        const escName = escapeHtml(senderName);
        const escTranscript = escapeHtml(transcript);
        const audioCaption =
          `🎙️ <b>${escName}</b> (<code>${from}</code>)\n\n📝 <i>${escTranscript}</i>`;
        const recipients = await getAllRecipients(env);
        for (const chatId of recipients) {
          try {
            await sendTelegramVoice(targetToken, chatId, media.buffer, audioCaption);
          } catch (e) {
            console.log(`[wa-webhook] tg push audio failed:`, (e as Error).message);
          }
        }
      } else {
        console.log("[wa-webhook] transcription failed, falling back to manual handoff");
        await handleInboundMedia(env, msg, ctx, from, senderName);
        return;
      }
    } else {
      await notifyMediaFailure(env, from, senderName, "audio", "");
      return;
    }
  }

  // ---- VISUAL MEDIA (image/video/document/sticker) ----
  // Forzar manual: la AI no interpreta fotos médicas.
  if (
    !isTranscribedAudio && (
      (msg.type === "image" && msg.image?.id) ||
      (msg.type === "document" && msg.document?.id) ||
      (msg.type === "video" && msg.video?.id) ||
      (msg.type === "sticker" && msg.sticker?.id)
    )
  ) {
    if (!from) return;
    await handleInboundMedia(env, msg, ctx, from, senderName);
    return;
  }

  // Texto: del mensaje normal o transcrito desde audio
  const text = isTranscribedAudio ? injectedText : extractText(msg);
  if (!from || !text) return;

  // ---- POP CUC desde WhatsApp (cualquier número) ----
  // Agenda de cirugías Clínica Colombia. Si alguien escribe "pop cuc" desde
  // cualquier WhatsApp, lo llevamos al flujo de agendamiento con Google Calendar.
  // Toma prioridad sobre la IA: si hay state activo, todos los mensajes son del
  // flujo hasta que se complete o se cancele.
  {
    const { isPopCucTrigger, handlePopCuc } = await import("../popCuc");
    const userId = `wa:${from}`;
    const hasState = await env.STATE.get(`popcuc:state:${userId}`);
    if (isPopCucTrigger(text) || hasState) {
      const popResult = await handlePopCuc(env, userId, text);
      if (popResult) {
        try { await sendText(env, from, popResult.reply); } catch { /* ignore */ }
        return;
      }
    }
  }

  // Save mapping (wa_id → name)
  try {
    await env.STATE.put(
      `wa:contact:${from}`,
      JSON.stringify({ name: senderName, lastSeenAt: Date.now() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
  } catch (e) {
    console.log("[wa-webhook] kv put failed:", (e as Error).message);
  }

  // ---- New contact: AI auto by default (no consent buttons) ----
  // The patient gets a brief greeting + the AI booking agent answers immediately.
  // They can opt out at any time by writing "humano".
  const consent = await env.STATE.get(`wa:consent:${from}`);
  let mode: WaMode = await getMode(env, from);

  if (!consent) {
    console.log(`[wa-webhook] new contact ${from} → defaulting to AI auto`);
    await env.STATE.put(`wa:consent:${from}`, "ai", { expirationTtl: 60 * 60 * 24 * 365 });
    await setMode(env, from, "auto");
    mode = "auto";

    // One-time greeting — short, surgeon-tone, no long disclaimers
    try {
      await sendText(
        env,
        from,
        `Hola${senderName !== "Desconocido" ? " " + senderName.split(" ")[0] : ""} 👋 Soy el Dr. David Duque. Cuéntame, ¿en qué te ayudo? (Si quieres hablar con mi equipo directamente, escribe "humano".)`,
      );
    } catch { /* ignore */ }

    const escapedNameNew = escapeHtml(senderName);
    const escapedTextNew = escapeHtml(text);
    await sendTelegram(
      env,
      `🆕🤖 <b>Nuevo paciente WhatsApp</b> <b>${escapedNameNew}</b> (<code>${from}</code>) — modo <b>AI auto</b>:\n\n📥 ${escapedTextNew}\n\n<i>El asistente AI le va a responder. Para tomar control: /wa_mode ${from} manual</i>`,
      [[
        { text: "✏️ Tomar control", callback_data: `wa_takeover:${from}` },
        { text: "🛑 Detener AI", callback_data: `wa_off:${from}` },
      ]],
    );
    // Fall through: process this same message with the AI agent below
  }

  // ---- "Humano" override: if patient asks for a human at any point, switch to manual ----
  if (/\b(humano|operador|persona real|asistente real|hablar (con )?(una )?persona|hablar con alguien)\b/i.test(text)) {
    console.log(`[wa-webhook] patient ${from} requested human`);
    await setMode(env, from, "manual");
    await env.STATE.put(`wa:consent:${from}`, "human", { expirationTtl: 60 * 60 * 24 * 365 });
    try {
      await sendText(env, from, "👤 Claro, te paso con un humano del equipo. En breve te responde.");
    } catch { /* ignore */ }

    // Preferimos handoff bot dedicado
    const cedula = await (async () => {
      const raw = await env.STATE.get(`wa:patientCtx:${from}`);
      if (!raw) return undefined;
      try { return JSON.parse(raw).cedula as string; } catch { return undefined; }
    })();
    const deliveredToHandoff = await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: text,
      reason: "Paciente pidió hablar con humano",
      cedula,
    });

    if (!deliveredToHandoff) {
      const escapedHName = escapeHtml(senderName);
      const escapedHText = escapeHtml(text);
      await sendTelegram(
        env,
        `🚨 <b>Paciente pidió humano</b>\n\n<b>De:</b> ${escapedHName} (<code>${from}</code>)\n\n📥 ${escapedHText}\n\n<i>Modo manual. /wa_reply ${from} TEXTO para responder.</i>`,
        modeKeyboardManual(from),
      );
    }
    try { await appendHistory(env, from, "user", text); } catch { /* ignore */ }
    return;
  }

  // Persist incoming turn for Claude conversation memory
  try {
    await appendHistory(env, from, "user", text);
  } catch (e) {
    console.log("[wa-webhook] appendHistory failed:", (e as Error).message);
  }

  console.log(`[wa-webhook] inbound from=${from} consent=${consent ?? "ai-default"} mode=${mode} text="${text.slice(0, 80)}"`);

  if (mode === "auto") {
    await handleAutoMode(env, from, senderName, text);
  } else if (mode === "review") {
    await handleReviewMode(env, from, senderName, text);
  } else {
    await handleManualMode(env, from, senderName, text);
  }
}

// ---- mode: manual (default) ----
async function handleManualMode(env: Env, from: string, senderName: string, text: string) {
  // ROUTING UNIFICADO según assignee del contacto:
  //   - assignee="andrea"  → mensajes van al bot de cotizaciones (consultorioandrea_bot)
  //   - assignee="doctor"  → mensajes van al handoff bot (consultadavid_bot)
  //   - assignee=null      → fallback a handoff bot (default cuando entra en manual)
  // Así la conversación QUEDA UNIFICADA en el bot del responsable actual.
  const assignee = await getAssignee(env, from);

  if (assignee === "andrea") {
    const ok = await sendQuotePatientMessage(env, {
      fromPhone: from,
      patientName: senderName,
      text,
    });
    if (ok) return;
    // Fallback si quotes bot no configurado: ir al handoff
  }

  // Default y caso doctor: handoff bot
  const delivered = await sendHandoffPatientMessage(env, {
    fromPhone: from,
    patientName: senderName,
    text,
  });
  if (delivered) return;

  // Último fallback: bot principal (si no hay ni handoff ni quotes configurados)
  const escaped = escapeHtml(text);
  const escapedName = escapeHtml(senderName);
  const tgText =
    `💬 <b>WhatsApp</b> de <b>${escapedName}</b> (<code>${from}</code>):\n\n` +
    `${escaped}`;
  await sendTelegram(env, tgText, modeKeyboardManual(from));
}

// ---- mode: review (Claude suggests, doctor approves) ----
async function handleReviewMode(env: Env, from: string, senderName: string, text: string) {
  const escapedName = escapeHtml(senderName);
  const escapedText = escapeHtml(text);

  const reply = await suggestReply(env, from, text);
  if (reply.shouldEscalate || !reply.text) {
    // Claude couldn't handle. Fallback to manual notice.
    const tgText =
      `⚠️ <b>Claude no pudo responder</b> (escaló) — modo revisión\n\n` +
      `<b>De:</b> ${escapedName} (<code>${from}</code>)\n\n` +
      `${escapedText}`;
    await sendTelegram(env, tgText, modeKeyboardManual(from));
    return;
  }

  // Save draft so the [✅ Send as-is] button can find it
  await env.STATE.put(`wa:draft:${from}`, reply.text, { expirationTtl: 60 * 60 * 24 });

  const escapedDraft = escapeHtml(reply.text);
  const tgText =
    `🤖 <b>Borrador de Claude</b> para responder a <b>${escapedName}</b> (<code>${from}</code>):\n\n` +
    `📥 <b>Mensaje recibido:</b>\n${escapedText}\n\n` +
    `📤 <b>Borrador:</b>\n<i>${escapedDraft}</i>`;

  await sendTelegram(env, tgText, [
    [
      { text: "✅ Enviar tal cual", callback_data: `wa_send:${from}` },
      { text: "✏️ Editar", callback_data: `wa_edit:${from}` },
    ],
    [
      { text: "🚫 Descartar", callback_data: `wa_discard:${from}` },
      { text: "🟢 Auto ON", callback_data: `wa_auto:${from}` },
    ],
  ]);
}

// ---- mode: auto (Claude booking agent responds directly) ----
async function handleAutoMode(env: Env, from: string, senderName: string, text: string) {
  // Use the booking agent (with Bukeala tools) instead of the simple suggestReply.
  const result = await runBookingAgent(env, from, text);
  const escapedName = escapeHtml(senderName);
  const escapedIn = escapeHtml(text);

  // Always send Claude's text response to the patient (even if escalated, the
  // text is friendly and can stand alone — e.g. "te paso a un humano").
  const sent = await sendText(env, from, result.finalText);
  if (sent.ok) {
    await appendHistory(env, from, "assistant", result.finalText);
  } else {
    const errMsg = sent.data?.error?.message ?? "unknown";
    console.log("[wa-webhook] auto-send failed:", errMsg);
  }

  if (result.shouldEscalate) {
    // Switch this contact to manual mode
    await setMode(env, from, "manual");

    // Preferimos mandar al bot de handoff dedicado si está configurado.
    const cedula = await (async () => {
      const raw = await env.STATE.get(`wa:patientCtx:${from}`);
      if (!raw) return undefined;
      try { return JSON.parse(raw).cedula as string; } catch { return undefined; }
    })();
    const deliveredToHandoff = await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: text,
      reason: result.escalateReason ?? "n/a",
      cedula,
      aiReply: result.finalText,
      intent: result.escalateIntent,
      urgency: result.escalateUrgency as "alta" | "media" | "baja" | undefined,
      suggestion: result.escalateSuggestion,
    });

    // Fallback: si el handoff bot no está configurado o falló, mandar al bot principal
    if (!deliveredToHandoff) {
      await sendTelegram(
        env,
        `🚨 <b>AI escaló a humano</b>\n` +
          `De: <b>${escapedName}</b> (<code>${from}</code>)\n` +
          `Razón: ${escapeHtml(result.escalateReason ?? "n/a")}\n\n` +
          `📥 ${escapedIn}\n\n` +
          `📤 AI respondió: <i>${escapeHtml(result.finalText)}</i>\n\n` +
          `<i>Modo manual. /wa_reply para responder, /wa_mode ${from} auto para devolver a AI.</i>`,
        modeKeyboardManual(from),
      );
    }
  } else {
    const escapedReply = escapeHtml(result.finalText);
    await sendTelegram(
      env,
      `🤖 <b>Auto-respondido</b> a ${escapedName} (<code>${from}</code>)\n\n` +
        `📥 ${escapedIn}\n\n` +
        `📤 ${escapedReply}`,
      [[
        { text: "🛑 Detener auto-modo", callback_data: `wa_off:${from}` },
        { text: "✏️ Tomar control", callback_data: `wa_takeover:${from}` },
      ]],
    );
  }
}

// Keyboard shown in manual mode (default forwarding)
function modeKeyboardManual(from: string) {
  return [
    [
      { text: "🤖 Sugerir con Claude", callback_data: `wa_suggest:${from}` },
      { text: "🟢 Activar auto", callback_data: `wa_auto:${from}` },
    ],
  ];
}

/**
 * Procesa la respuesta del paciente al botón de confirmación de cita.
 * `confirmed=true` → tocó "✅ Sí, confirmo"; false → "❌ No podré".
 *
 * Guarda el estado por reservationCode (para que la agenda de la asistente
 * muestre ✅/❌) y notifica al equipo por Telegram. No pasa el mensaje a la IA.
 */
async function handleConfirmReply(
  env: Env,
  from: string,
  senderName: string,
  confirmed: boolean,
): Promise<void> {
  let info: { reservationCode?: string; name?: string; dateFriendly?: string; time?: string } | null = null;
  try {
    const raw = await env.STATE.get(`wa:pendingConfirm:${from}`);
    info = raw ? JSON.parse(raw) : null;
  } catch { /* ignore */ }

  const value = confirmed ? "si" : "no";
  if (info?.reservationCode) {
    await env.STATE.put(`wa:citaConfirm:${info.reservationCode}`, value, {
      expirationTtl: 60 * 60 * 24 * 3,
    });
  }
  // Flag por teléfono (respaldo si no hubo reservationCode)
  await env.STATE.put(`wa:confirmFlag:${from}`, value, { expirationTtl: 60 * 60 * 24 * 2 });

  // Acuse al paciente
  try {
    await sendText(
      env,
      from,
      confirmed
        ? "¡Gracias! Su cita queda confirmada. Lo/la esperamos. 🙏"
        : "Entendido, gracias por avisar. El equipo lo/la contactará para reagendar.",
    );
  } catch { /* ignore */ }

  // Aviso al equipo (doctor + asistente) por Telegram
  const detalle = info
    ? `${escapeHtml(info.name ?? senderName)} · ${escapeHtml(info.dateFriendly ?? "")} ${escapeHtml(info.time ?? "")}`
    : escapeHtml(senderName);
  const header = confirmed ? "✅ <b>Paciente CONFIRMÓ</b>" : "❌ <b>Paciente NO podrá asistir</b>";
  await sendTelegram(
    env,
    `${header}\n${detalle}\n<code>${from}</code>` +
      (confirmed ? "" : "\n\n<i>Reagendar / liberar el cupo.</i>"),
  );
  console.log(`[wa-webhook] cita ${value} from=${from} code=${info?.reservationCode ?? "?"}`);
}

async function sendTelegram(
  env: Env,
  text: string,
  inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>,
) {
  // Broadcast WhatsApp inbound messages to ALL authorized users (doctor + secretary)
  // so whoever is available can respond.
  const recipients = await getAllRecipients(env);
  for (const chatId of recipients) {
    try {
      await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          reply_markup: inline_keyboard ? { inline_keyboard } : undefined,
        }),
      });
    } catch (e) {
      console.log(`[wa-webhook] telegram send failed (chat=${chatId}):`, (e as Error).message);
    }
  }
}

async function handleStatusUpdate(
  env: Env,
  status: NonNullable<NonNullable<NonNullable<WAWebhookEntry["changes"]>[number]["value"]>["statuses"]>[number],
): Promise<void> {
  const { id, status: s, recipient_id, errors } = status;
  console.log(`[wa-webhook] status msg=${id} status=${s} to=${recipient_id}`);
  if (s === "failed" && errors && errors.length > 0) {
    const errMsg = errors.map((e) => `${e.code}: ${e.title} — ${e.message}`).join("\n");
    await sendTelegram(
      env,
      `❌ <b>WhatsApp falló</b> a <code>${escapeHtml(recipient_id ?? "?")}</code>\n` +
        `Msg ID: <code>${escapeHtml(id ?? "?")}</code>\n\n${escapeHtml(errMsg)}`,
    );
  }
}

function extractText(
  msg: NonNullable<NonNullable<NonNullable<WAWebhookEntry["changes"]>[number]["value"]>["messages"]>[number],
): string {
  if (msg.type === "text" && msg.text?.body) return msg.text.body;
  if (msg.type === "button" && msg.button?.text) return `[Botón] ${msg.button.text}`;
  if (msg.type === "interactive") {
    const ir = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    if (ir?.title) return `[Selección] ${ir.title}`;
  }
  return "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ====================================================================
// Inbound media handler: WA media → Telegram (handoff bot or main fallback)
// ====================================================================
async function handleInboundMedia(
  env: Env,
  msg: NonNullable<NonNullable<NonNullable<WAWebhookEntry["changes"]>[number]["value"]>["messages"]>[number],
  _ctx: NonNullable<WAWebhookEntry["changes"]>[number]["value"],
  from: string,
  senderName: string,
): Promise<void> {
  // Save mapping
  try {
    await env.STATE.put(
      `wa:contact:${from}`,
      JSON.stringify({ name: senderName, lastSeenAt: Date.now() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
  } catch {/* ignore */}

  // Always switch to manual: AI shouldn't interpret medical media
  await setMode(env, from, "manual");

  // Identify media + download
  let mediaId = "";
  let kind: "image" | "document" | "audio" | "video" | "sticker" = "image";
  let caption = "";
  let filename = "";

  if (msg.type === "image" && msg.image?.id) {
    mediaId = msg.image.id;
    kind = "image";
    caption = msg.image.caption ?? "";
  } else if (msg.type === "document" && msg.document?.id) {
    mediaId = msg.document.id;
    kind = "document";
    caption = msg.document.caption ?? "";
    filename = msg.document.filename ?? "documento";
  } else if (msg.type === "audio" && msg.audio?.id) {
    mediaId = msg.audio.id;
    kind = "audio";
  } else if (msg.type === "video" && msg.video?.id) {
    mediaId = msg.video.id;
    kind = "video";
    caption = msg.video.caption ?? "";
  } else if (msg.type === "sticker" && msg.sticker?.id) {
    mediaId = msg.sticker.id;
    kind = "sticker";
  } else {
    return;
  }

  console.log(`[wa-webhook] inbound ${kind} id=${mediaId} from=${from}`);

  // Append text marker to history (so AI/Telegram has context)
  const marker = `[${iconFor(kind)} ${kind}${caption ? `: ${caption.slice(0, 200)}` : ""}]`;
  try { await appendHistory(env, from, "user", marker); } catch {/* ignore */}

  // Download bytes from WA
  const media = await downloadWAMedia(env, mediaId);
  if (!media) {
    // Fallback: solo notificación de texto
    await notifyMediaFailure(env, from, senderName, kind, caption);
    return;
  }

  // Push to Telegram. Prefer handoff bot if configured.
  const handoffToken = env.TELEGRAM_HANDOFF_BOT_TOKEN;
  const targetToken = handoffToken || env.TELEGRAM_BOT_TOKEN;
  const escName = escapeHtml(senderName);
  const escCaption = caption ? escapeHtml(caption) : "";

  const headerHtml =
    `${iconFor(kind)} <b>${escName}</b> (<code>${from}</code>)` +
    (escCaption ? `\n\n<i>${escCaption}</i>` : "");

  const recipients = await getAllRecipients(env);
  for (const chatId of recipients) {
    try {
      let ok = false;
      if (kind === "image" || kind === "sticker") {
        ok = await sendTelegramPhoto(targetToken, chatId, media.buffer, headerHtml);
      } else if (kind === "document") {
        ok = await sendTelegramDocument(targetToken, chatId, media.buffer, filename || "documento", media.mimeType, headerHtml);
      } else if (kind === "audio") {
        ok = await sendTelegramVoice(targetToken, chatId, media.buffer, headerHtml);
      } else if (kind === "video") {
        // Reproducible inline (Telegram sendVideo). Si falla por tamaño/codec, fallback a documento.
        ok = await sendTelegramVideo(targetToken, chatId, media.buffer, headerHtml);
        if (!ok) {
          console.log(`[wa-webhook] sendVideo falló, fallback a sendDocument`);
          ok = await sendTelegramDocument(targetToken, chatId, media.buffer, "video.mp4", media.mimeType, headerHtml);
        }
      }
      if (!ok) {
        console.log(`[wa-webhook] tg send to ${chatId} failed for ${kind}`);
      }
    } catch (e) {
      console.log(`[wa-webhook] tg push failed:`, (e as Error).message);
    }
  }

  // También un mensaje de texto al handoff bot con los botones [📤 Responder] [🔚 Devolver IA]
  // para que el doctor sepa que es escalación y pueda responder rápido.
  if (handoffToken) {
    const cedula = await (async () => {
      const raw = await env.STATE.get(`wa:patientCtx:${from}`);
      if (!raw) return undefined;
      try { return JSON.parse(raw).cedula as string; } catch { return undefined; }
    })();
    await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: marker + (caption ? ` "${caption}"` : ""),
      reason: `Paciente envió ${kind}`,
      cedula,
    });
  } else {
    // Si no hay handoff bot, mandar solo texto al main bot con los keyboards
    await sendTelegram(
      env,
      `🚨 <b>Paciente envió ${kind}</b>\nDe: <b>${escName}</b> (<code>${from}</code>)\n${escCaption ? `\n<i>${escCaption}</i>\n` : ""}\n<i>Modo manual. /wa_reply ${from} TEXTO o /wa_mode ${from} auto.</i>`,
      modeKeyboardManual(from),
    );
  }
}

function iconFor(kind: string): string {
  switch (kind) {
    case "image": return "📷";
    case "document": return "📄";
    case "audio": return "🎙️";
    case "video": return "🎥";
    case "sticker": return "🌟";
    default: return "📎";
  }
}

async function notifyMediaFailure(
  env: Env,
  from: string,
  senderName: string,
  kind: string,
  caption: string,
): Promise<void> {
  const text =
    `⚠️ <b>${escapeHtml(senderName)}</b> envió un <b>${kind}</b> pero no pudimos descargarlo.\n` +
    `<code>${from}</code>` +
    (caption ? `\n\n<i>${escapeHtml(caption)}</i>` : "");
  await sendTelegram(env, text, modeKeyboardManual(from));
}
