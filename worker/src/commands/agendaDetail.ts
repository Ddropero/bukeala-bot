/**
 * Agenda detail module — adds a tap-to-view-detail flow on top of /agenda.
 *
 * Flow:
 *   1. After showAgenda() renders the main agenda message, the integrator calls
 *      buildAgendaDetailKeyboard(env, chatId, bookings) and sends its result as
 *      a SECOND message (e.g. "Toca una cita para ver detalle:").
 *   2. The keyboard contains one button per active (non-canceled, non-busy)
 *      booking. Each button has callback_data = `agenda_detail:<idx>`, where
 *      <idx> is the booking's index in the original `bookings` array.
 *   3. The integrator routes that callback to showAgendaBookingDetail(env,
 *      chatId, idx), which reads the cached booking from KV and sends a
 *      detailed message with all available fields.
 *
 * Cache:
 *   The full bookings array is stored under `agendaCache:<chatId>` with a
 *   15-minute TTL. After expiration, taps yield a friendly "expired" message
 *   asking the user to re-run /agenda.
 *
 * This module is fully self-contained: it duplicates the Telegram fetch helper
 * (sendMessage) so it does NOT import anything from telegram.ts.
 */
import type { Env } from "../env";

// ====================================================================
// Telegram helpers — duplicated from telegram.ts to keep this module
// independent of shared files (per integration constraints).
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
// Types — mirror the Bukeala /agenda response shape
// ====================================================================
type AgendaBooking = {
  id?: number;
  bookingCode?: string;
  name?: string;
  identification?: string;
  identificationTypeShortCode?: string;
  stateCode?: string;
  stateDesc?: string;
  bookingComponentName?: string;
  planName?: string;
  isCanceled?: boolean;
  cancelationReason?: string | null;
  isPresential?: boolean;
  isBusyTime?: boolean;
  startHourFormatted?: string;
  endHourFormatted?: string;
  duration?: number;
  durationInSeconds?: number;
  email?: string;
  phone?: string;
  cellPhone?: string | { phoneNumber?: string } | null;
  meetLink?: string;
  meetingLink?: string;
  virtualMeetingLink?: string;
  [key: string]: unknown;
};

type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

const CACHE_TTL_SECONDS = 60 * 15;
const cacheKey = (chatId: string) => `agendaCache:${chatId}`;

// ====================================================================
// Public API
// ====================================================================

/**
 * Build the inline keyboard for tapping into agenda bookings. Also persists
 * the full bookings array in KV under `agendaCache:<chatId>` so the callback
 * handler can resolve `agenda_detail:<idx>` later.
 *
 * Only includes a button when the booking is NOT canceled AND NOT a busy
 * time block. Button text is `<startHour> — <name>` truncated to 30 chars.
 *
 * Returns an `InlineKeyboard` ready to pass as `reply_markup` on a Telegram
 * sendMessage call. The caller decides what message body to attach the
 * keyboard to (e.g. "Toca una cita para ver el detalle:").
 */
export async function buildAgendaDetailKeyboard(
  env: Env,
  chatId: string,
  bookings: AgendaBooking[],
): Promise<InlineKeyboard> {
  // Always cache the full array — even canceled/busy bookings — so the index
  // in `agenda_detail:<idx>` always matches the array the caller passed in.
  await env.STATE.put(cacheKey(chatId), JSON.stringify(bookings), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  console.log(
    `[agendaDetail] cached ${bookings.length} bookings for chat ${chatId} (ttl ${CACHE_TTL_SECONDS}s)`,
  );

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < bookings.length; i++) {
    const bk = bookings[i];
    if (bk?.isCanceled) continue;
    if (bk?.stateCode === "CANCELED") continue;
    if (bk?.isBusyTime) continue;

    const time = (bk.startHourFormatted ?? "").trim();
    const name = (bk.name ?? "").trim();
    const rawLabel = time && name ? `${time} — ${name}` : time || name || `Cita ${i + 1}`;
    const label = truncate(rawLabel, 30);

    rows.push([{ text: label, callback_data: `agenda_detail:${i}` }]);
  }
  console.log(`[agendaDetail] built keyboard with ${rows.length} buttons`);

  return { inline_keyboard: rows };
}

/**
 * Handle a tap on an `agenda_detail:<idx>` button. Loads the cached bookings
 * for `chatId` and sends a detailed message for `bookings[idx]`. If the cache
 * has expired or the index is out of range, sends a friendly recovery message.
 */
export async function showAgendaBookingDetail(
  env: Env,
  chatId: string,
  idx: number,
): Promise<void> {
  const raw = await env.STATE.get(cacheKey(chatId));
  if (!raw) {
    console.log(`[agendaDetail] cache MISS for chat ${chatId}`);
    await sendMessage(env, chatId, "Cita expiró del cache; corre /agenda de nuevo");
    return;
  }

  let bookings: AgendaBooking[];
  try {
    const parsed = JSON.parse(raw);
    bookings = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.log(`[agendaDetail] cache parse error: ${(err as Error).message}`);
    await sendMessage(env, chatId, "Cita expiró del cache; corre /agenda de nuevo");
    return;
  }

  if (idx < 0 || idx >= bookings.length) {
    console.log(
      `[agendaDetail] idx ${idx} out of range (have ${bookings.length} bookings)`,
    );
    await sendMessage(env, chatId, "Cita expiró del cache; corre /agenda de nuevo");
    return;
  }

  const bk = bookings[idx];
  console.log(
    `[agendaDetail] rendering detail for idx ${idx}, bookingCode=${bk?.bookingCode ?? "?"}`,
  );
  await sendMessage(env, chatId, formatBookingDetail(bk));
}

// ====================================================================
// Detail formatting
// ====================================================================
function formatBookingDetail(bk: AgendaBooking): string {
  const time = (bk.startHourFormatted ?? "").trim();
  const endTime = (bk.endHourFormatted ?? "").trim();
  const lines: string[] = [];

  // Header
  lines.push(`📋 <b>Cita ${escapeHtml(time || "(sin hora)")}</b>`);
  lines.push("");

  // Name
  lines.push(`👤 <b>${escapeHtml((bk.name ?? "").trim() || "(sin nombre)")}</b>`);

  // ID
  const docType = (bk.identificationTypeShortCode ?? "").trim();
  const docNum = (bk.identification ?? "").trim();
  if (docType || docNum) {
    lines.push(`🆔 ${escapeHtml(`${docType} ${docNum}`.trim())}`);
  }

  // Specialty / component name
  const component = (bk.bookingComponentName ?? "").trim();
  if (component) {
    lines.push(`🩺 ${escapeHtml(component)}`);
  }

  // Plan
  const plan = (bk.planName ?? "").trim();
  if (plan) {
    lines.push(`📝 Plan: ${escapeHtml(plan)}`);
  }

  // State
  const stateDesc = (bk.stateDesc ?? "").trim() || (bk.stateCode ?? "").trim();
  if (stateDesc) {
    lines.push(`📅 Estado: ${escapeHtml(stateDesc)}`);
  }

  // Duration
  const duration = computeDurationMinutes(bk);
  if (time && endTime && duration != null) {
    lines.push(`⏱ Duración: ${duration} min (${escapeHtml(time)} - ${escapeHtml(endTime)})`);
  } else if (time && endTime) {
    lines.push(`⏱ Horario: ${escapeHtml(time)} - ${escapeHtml(endTime)}`);
  } else if (duration != null) {
    lines.push(`⏱ Duración: ${duration} min`);
  }

  // Modality
  if (typeof bk.isPresential === "boolean") {
    lines.push(`📍 Modalidad: ${bk.isPresential ? "Presencial" : "Virtual"}`);
  }

  // Booking code
  const code = (bk.bookingCode ?? "").trim();
  if (code) {
    lines.push(`🔖 Código: <code>${escapeHtml(code)}</code>`);
  }

  // Email
  const email = extractEmail(bk);
  lines.push(`✉️ Email: ${email ? escapeHtml(email) : "(no registrado)"}`);

  // Phone
  const phone = extractPhone(bk);
  lines.push(`📞 Teléfono: ${phone ? escapeHtml(phone) : "(no registrado)"}`);

  // Virtual meeting link (if applicable)
  const meet = extractMeetLink(bk);
  if (meet) {
    lines.push(`🔗 Enlace virtual: ${escapeHtml(meet)}`);
  }

  // Cancelation info
  if (bk.isCanceled || bk.stateCode === "CANCELED") {
    const reason = (bk.cancelationReason ?? "").toString().trim();
    lines.push("");
    lines.push(`❌ <b>Cancelada</b>${reason ? `: ${escapeHtml(reason)}` : ""}`);
  }

  return lines.join("\n");
}

function computeDurationMinutes(bk: AgendaBooking): number | null {
  if (typeof bk.duration === "number" && bk.duration > 0) return bk.duration;
  if (typeof bk.durationInSeconds === "number" && bk.durationInSeconds > 0) {
    return Math.round(bk.durationInSeconds / 60);
  }
  return null;
}

function extractEmail(bk: AgendaBooking): string {
  const candidates = [bk.email, (bk as Record<string, unknown>).customerEmail];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c.trim();
  }
  return "";
}

function extractPhone(bk: AgendaBooking): string {
  if (typeof bk.phone === "string" && bk.phone.trim()) return bk.phone.trim();
  if (typeof bk.cellPhone === "string" && bk.cellPhone.trim()) return bk.cellPhone.trim();
  if (
    bk.cellPhone &&
    typeof bk.cellPhone === "object" &&
    typeof (bk.cellPhone as { phoneNumber?: string }).phoneNumber === "string"
  ) {
    const n = (bk.cellPhone as { phoneNumber?: string }).phoneNumber;
    if (n && n.trim()) return n.trim();
  }
  const customerPhone = (bk as Record<string, unknown>).customerPhone;
  if (typeof customerPhone === "string" && customerPhone.trim()) return customerPhone.trim();
  return "";
}

function extractMeetLink(bk: AgendaBooking): string {
  const candidates = [bk.meetLink, bk.meetingLink, bk.virtualMeetingLink];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().startsWith("http")) return c.trim();
  }
  return "";
}

// ====================================================================
// Internal helpers
// ====================================================================
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}
