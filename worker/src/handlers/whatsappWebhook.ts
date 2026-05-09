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

  const text = extractText(msg);
  if (!from || !text) return;

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

  // ---- Consent gate: if no consent yet, send welcome with buttons ----
  // Skip if doctor manually overrode the mode (then mode != "manual" or contact already set)
  const consent = await env.STATE.get(`wa:consent:${from}`);
  const mode: WaMode = await getMode(env, from);
  const explicitMode = mode !== "manual"; // doctor pre-set this contact

  if (!consent && !explicitMode) {
    console.log(`[wa-webhook] no consent yet for ${from} → sending welcome buttons`);
    try {
      await env.STATE.put(`wa:consent:${from}`, "pending", { expirationTtl: 60 * 60 * 24 * 7 });
      await sendInteractiveButtons(
        env,
        from,
        `¡Hola${senderName !== "Desconocido" ? " " + senderName : ""}! 👋\n\nSoy el asistente del Dr. David Duque, cirujano plástico.\n\n¿Cómo prefieres ser atendido?`,
        [
          { id: "consent_ai", title: "🤖 Asistente AI" },
          { id: "consent_human", title: "👤 Humano" },
        ],
        undefined,
        "Puedes cambiar de opción más adelante.",
      );
      // Also forward the message to Telegram so doctor sees the first contact
      const escapedName = escapeHtml(senderName);
      const escapedText = escapeHtml(text);
      await sendTelegram(
        env,
        `🆕 <b>Primer mensaje WhatsApp</b> de <b>${escapedName}</b> (<code>${from}</code>):\n\n${escapedText}\n\n<i>Le envié botones para que elija AI o humano.</i>`,
        modeKeyboardManual(from),
      );
    } catch (e) {
      console.log("[wa-webhook] welcome send failed:", (e as Error).message);
      // Fallback: process as manual
      await handleManualMode(env, from, senderName, text);
    }
    // Persist for Claude memory either way
    try { await appendHistory(env, from, "user", text); } catch { /* ignore */ }
    return;
  }

  // Persist incoming turn for Claude conversation memory
  try {
    await appendHistory(env, from, "user", text);
  } catch (e) {
    console.log("[wa-webhook] appendHistory failed:", (e as Error).message);
  }

  console.log(`[wa-webhook] inbound from=${from} consent=${consent} mode=${mode} text="${text.slice(0, 80)}"`);

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
    // Switch this contact to manual mode + notify Telegram
    await setMode(env, from, "manual");
    await sendTelegram(
      env,
      `🚨 <b>Claude escaló a humano</b>\n` +
        `De: <b>${escapedName}</b> (<code>${from}</code>)\n` +
        `Razón: ${escapeHtml(result.escalateReason ?? "n/a")}\n\n` +
        `📥 ${escapedIn}\n\n` +
        `📤 Claude respondió: <i>${escapeHtml(result.finalText)}</i>\n\n` +
        `<i>Modo cambió a manual. Usa /wa_reply para responder o /wa_mode ${from} auto para volver a Claude.</i>`,
      modeKeyboardManual(from),
    );
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
