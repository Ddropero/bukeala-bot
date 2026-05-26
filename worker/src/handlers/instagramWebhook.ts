/**
 * Instagram Messaging webhook handler (vía Meta Graph API).
 *
 * Meta envía:
 *   GET  /ig/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 *        → echo de hub.challenge si verify_token coincide
 *   POST /ig/webhook
 *        → JSON con DMs entrantes, reacciones, etc.
 *
 * El flow para mensajes entrantes es prácticamente idéntico al de WhatsApp,
 * solo cambia el canal (INSTAGRAM_CHANNEL) que el booking agent usa para:
 *   - Prefijar las keys de KV (ig:patientCtx:..., ig:history:..., etc.)
 *   - Enviar las respuestas vía Instagram Send API (no WhatsApp)
 *   - Saltarse el envío de templates WA en book_appointment exitoso
 *     (Instagram no tiene templates aprobados)
 */
import type { Context } from "hono";
import type { Env } from "../env";
import { getIgUserProfile, sendIgText, sendIgSenderAction } from "../instagram";
import { runBookingAgent } from "../claudeBookingAgent";
import { appendHistory, getMode, setMode, type WaMode } from "../claudeAi";
import { getAllRecipients } from "../users";
import { sendHandoffNotification } from "../handoffBot";
import { INSTAGRAM_CHANNEL } from "../messagingChannel";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

interface IGMessagingEntry {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    attachments?: Array<{
      type?: string; // image, video, audio, file, share, story_mention, ig_reel
      payload?: { url?: string };
    }>;
    quick_reply?: { payload?: string };
    is_echo?: boolean;
    is_unsupported?: boolean;
  };
  postback?: {
    title?: string;
    payload?: string;
  };
}

interface IGWebhookPayload {
  object?: string; // "instagram"
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: IGMessagingEntry[];
  }>;
}

export async function verifyInstagramWebhook(c: Context<{ Bindings: Env }>) {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge") ?? "";

  if (!c.env.IG_VERIFY_TOKEN) {
    console.log("[ig-webhook] IG_VERIFY_TOKEN no configurado");
    return c.text("not configured", 503);
  }
  if (mode === "subscribe" && token === c.env.IG_VERIFY_TOKEN) {
    console.log("[ig-webhook] verified ok");
    return c.text(challenge, 200);
  }
  console.log("[ig-webhook] verify failed", { mode, tokenMatches: token === c.env.IG_VERIFY_TOKEN });
  return c.text("forbidden", 403);
}

export async function handleInstagramWebhook(c: Context<{ Bindings: Env }>) {
  let payload: IGWebhookPayload = {};
  try {
    payload = await c.req.json<IGWebhookPayload>();
  } catch (e) {
    console.log("[ig-webhook] invalid json", (e as Error).message);
    return c.json({ ok: true });
  }

  c.executionCtx.waitUntil(
    processIgPayload(c.env, payload).catch((err) => {
      console.error("[ig-webhook] processing failed", err);
    }),
  );

  // Siempre 200 — Meta reintenta agresivamente si no
  return c.json({ ok: true });
}

async function processIgPayload(env: Env, payload: IGWebhookPayload): Promise<void> {
  if (payload.object !== "instagram") {
    console.log("[ig-webhook] object no es instagram:", payload.object);
    return;
  }
  for (const entry of payload.entry ?? []) {
    for (const msg of entry.messaging ?? []) {
      await handleIgMessage(env, msg);
    }
  }
}

async function handleIgMessage(env: Env, msg: IGMessagingEntry): Promise<void> {
  // Ignorar echoes (mensajes que TÚ mandaste desde el bot, no del paciente)
  if (msg.message?.is_echo) return;
  if (msg.message?.is_unsupported) {
    console.log("[ig-webhook] mensaje no soportado por Meta, skip");
    return;
  }

  const from = msg.sender?.id ?? "";
  if (!from) return;

  // Postback (botón quick_reply o action)
  let inboundText = msg.message?.text ?? "";
  if (!inboundText && msg.message?.quick_reply?.payload) {
    inboundText = `[Selección] ${msg.message.quick_reply.payload}`;
  }
  if (!inboundText && msg.postback?.payload) {
    inboundText = msg.postback.title || msg.postback.payload;
  }

  // Attachments: imagen / video / audio / archivo
  const attachments = msg.message?.attachments ?? [];
  if (attachments.length > 0 && !inboundText) {
    // Por ahora: notificar al handoff bot que llegó multimedia (no procesamos
    // con AI). El doctor decide cómo responder.
    return await handleIgMedia(env, from, attachments);
  }

  if (!inboundText) {
    console.log("[ig-webhook] mensaje sin texto ni attachments");
    return;
  }

  // Lookup name del usuario (1ª vez, sino usar cache)
  let senderName = "Usuario Instagram";
  const contactRaw = await env.STATE.get(`ig:contact:${from}`);
  if (contactRaw) {
    try {
      const c = JSON.parse(contactRaw);
      if (c.name) senderName = c.name;
    } catch { /* ignore */ }
  } else {
    const profile = await getIgUserProfile(env, from);
    if (profile?.name) senderName = profile.name;
    else if (profile?.username) senderName = "@" + profile.username;
    await env.STATE.put(
      `ig:contact:${from}`,
      JSON.stringify({
        name: senderName,
        username: profile?.username,
        lastSeenAt: Date.now(),
      }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
  }

  console.log(`[ig-webhook] inbound from=${from} (${senderName}) text="${inboundText.slice(0, 80)}"`);

  // First-contact: auto-mode por default, igual que WhatsApp
  const consent = await env.STATE.get(`ig:consent:${from}`);
  let mode: WaMode = (await env.STATE.get(`ig:mode:${from}`) as WaMode | null) ?? "manual";
  if (!consent) {
    console.log(`[ig-webhook] new contact ${from} → defaulting to AI auto`);
    await env.STATE.put(`ig:consent:${from}`, "ai", { expirationTtl: 60 * 60 * 24 * 365 });
    await env.STATE.put(`ig:mode:${from}`, "auto", { expirationTtl: 60 * 60 * 24 * 30 });
    mode = "auto";

    // Greeting único + indicar typing
    try {
      await sendIgSenderAction(env, from, "mark_seen");
      await sendIgSenderAction(env, from, "typing_on");
    } catch { /* ignore */ }

    // Notificar al doctor que llegó un paciente nuevo por IG
    try {
      const recipients = await getAllRecipients(env);
      const tgText =
        `🆕📷 <b>Nuevo paciente Instagram</b> <b>${escapeHtml(senderName)}</b>\n` +
        `📥 ${escapeHtml(inboundText.slice(0, 300))}\n\n` +
        `<i>La IA está respondiendo. /ig_mode ${from} manual para tomar control.</i>`;
      for (const chatId of recipients) {
        await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: tgText, parse_mode: "HTML" }),
        });
      }
    } catch { /* ignore */ }
  }

  // "Humano" override
  if (/\b(humano|operador|persona real|asistente real|hablar (con )?(una )?persona|hablar con alguien)\b/i.test(inboundText)) {
    await env.STATE.put(`ig:mode:${from}`, "manual", { expirationTtl: 60 * 60 * 24 * 30 });
    await env.STATE.put(`ig:consent:${from}`, "human", { expirationTtl: 60 * 60 * 24 * 365 });
    try {
      await sendIgText(env, from, "👤 Claro, te paso con un humano del equipo. En breve te responde.");
    } catch { /* ignore */ }
    await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: inboundText,
      reason: "Paciente IG pidió hablar con humano",
    });
    try { await appendHistory(env, from, "user", inboundText, "ig"); } catch { /* ignore */ }
    return;
  }

  // Persistir turn del paciente
  try {
    await appendHistory(env, from, "user", inboundText, "ig");
  } catch { /* ignore */ }

  // Manual / review / auto
  if (mode === "manual") {
    // Solo reenviar al handoff bot
    await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: inboundText,
      reason: "Mensaje Instagram en modo manual",
    });
    return;
  }

  if (mode !== "auto") {
    console.log(`[ig-webhook] mode=${mode} not handled, defaulting to manual notify`);
    await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: inboundText,
      reason: `Mensaje Instagram en modo ${mode}`,
    });
    return;
  }

  // Auto mode → AI booking agent con canal Instagram
  try { await sendIgSenderAction(env, from, "typing_on"); } catch { /* ignore */ }
  const result = await runBookingAgent(env, from, inboundText, INSTAGRAM_CHANNEL);

  const sent = await sendIgText(env, from, result.finalText);
  if (sent.ok) {
    await appendHistory(env, from, "assistant", result.finalText, "ig");
  } else {
    console.log("[ig-webhook] sendIgText falló:", sent.data);
  }

  if (result.shouldEscalate) {
    await env.STATE.put(`ig:mode:${from}`, "manual", { expirationTtl: 60 * 60 * 24 * 30 });
    await sendHandoffNotification(env, {
      fromPhone: from,
      patientName: senderName,
      message: inboundText,
      reason: result.escalateReason ?? "AI escaló",
      aiReply: result.finalText,
    });
  }
}

async function handleIgMedia(
  env: Env,
  from: string,
  attachments: NonNullable<IGMessagingEntry["message"]>["attachments"],
): Promise<void> {
  const types = (attachments ?? []).map((a) => a.type ?? "?").join(", ");
  // IG attachments tienen url temporal — los reenviamos al handoff por ahora
  await env.STATE.put(`ig:mode:${from}`, "manual", { expirationTtl: 60 * 60 * 24 * 30 });
  const contactRaw = await env.STATE.get(`ig:contact:${from}`);
  let name = "(usuario IG)";
  if (contactRaw) {
    try { name = JSON.parse(contactRaw).name ?? name; } catch { /* ignore */ }
  }
  await sendHandoffNotification(env, {
    fromPhone: from,
    patientName: name,
    message: `[Instagram media: ${types}]`,
    reason: "Paciente envió media por Instagram (foto/video/audio)",
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
