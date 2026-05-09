/**
 * Daily morning summary cron handler.
 *
 * Sends a single Telegram message at the configured time (e.g. 7:00 AM
 * Colombia = 12:00 UTC) summarizing today's agenda for AREA_ID = 1074:
 * - total non-canceled, non-busy bookings,
 * - first and last appointment (time + patient name),
 * - prompt to use /hoy for the full grid.
 *
 * Triggers from the Worker `scheduled()` handler (see index.ts integration).
 *
 * Behavior contract:
 * - If there is no Bukeala session captured yet → silently no-op.
 * - If the session expires mid-call → log and no-op (the keepAlive cron
 *   already notifies the user about expiry; we don't want to double-notify).
 * - If there are zero bookings → send the "Sin citas agendadas" variant.
 * - All "today" reasoning is anchored to Colombia time (UTC-5, no DST).
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { getAllRecipients } from "../users";

// AREA_ID for the doctor's calendar — same constant used by /hoy and /agenda.
const AREA_ID = 1074;

// Colombia is UTC-5 year-round (no DST).
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

// Subset of the booking shape we care about for the summary. Mirrors the
// AgendaBooking type in telegram.ts but only includes fields we actually read.
type SummaryBooking = {
  startHourFormatted: string; // e.g. "08:00 AM"
  name: string;
  stateCode: string;
  isCanceled: boolean;
  isBusyTime: boolean;
};

export async function dailySummary(env: Env): Promise<void> {
  // 1. No session → bail. Don't notify; keepAlive already handles user-facing
  //    "session expired" messaging when applicable.
  const session = await loadSession(env);
  if (!session) {
    console.log("[dailySummary] no session — skipping");
    return;
  }

  // 2. Compute today's date in Colombia time.
  const today = nowInColombia();
  const dateDashed = dateToDdMmYyyy(today);   // "06-05-2026" → for getAgenda
  const friendly = dateToFriendly(today);     // "06/05/26"   → for the header

  // 3. Fetch the agenda. Treat session-expiry as a no-op (keepAlive notifies).
  let bookings: SummaryBooking[] = [];
  try {
    const b = new Bukeala(env);
    const res = await b.getAgenda(dateDashed, AREA_ID, /* includeCanceled */ false);
    const json = (await res.json<{ areas?: Array<{ bookings?: SummaryBooking[] }> }>().catch(() => null)) as
      | { areas?: Array<{ bookings?: SummaryBooking[] }> }
      | null;
    bookings = json?.areas?.[0]?.bookings ?? [];
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.log("[dailySummary] session expired during getAgenda — skipping (keepAlive will notify)");
      return;
    }
    console.log("[dailySummary] getAgenda failed:", (e as Error).message);
    return;
  }

  // 4. Filter out canceled appointments and busy-time blocks.
  const active = bookings.filter(
    (bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime,
  );

  // 5. Build the HTML message. Two variants: empty vs. populated.
  let text: string;
  if (active.length === 0) {
    text = `🌅 Hoy ${friendly} — Sin citas agendadas.`;
  } else {
    // Sort by start time so first/last are stable regardless of API order.
    const sorted = [...active].sort((a, b) =>
      timeKey(a.startHourFormatted) - timeKey(b.startHourFormatted),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const lines: string[] = [
      `🌅 <b>Buenos días — Agenda hoy (${friendly})</b>`,
      "",
      `${active.length} ${active.length === 1 ? "cita pendiente" : "citas pendientes"}`,
      `Primera: ${first.startHourFormatted} — ${escapeHtml(first.name)}`,
    ];
    // Only show "Última" when we have more than one appointment, otherwise
    // it's redundant noise.
    if (active.length > 1) {
      lines.push(`Última: ${last.startHourFormatted} — ${escapeHtml(last.name)}`);
    }
    lines.push("", "Tap /hoy para ver detalle.");
    text = lines.join("\n");
  }

  // 6. Broadcast to ALL authorized users (doctor + secretaries).
  try {
    const recipients = await getAllRecipients(env);
    for (const chatId of recipients) {
      const tgRes = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );
      console.log(`[dailySummary] sent (count=${active.length}) → chat=${chatId} status=${tgRes.status}`);
    }
  } catch (sendErr) {
    console.log("[dailySummary] send failed:", (sendErr as Error).message);
  }
}

// ====================================================================
// Internal helpers (kept local so this module is self-contained — the
// rule says NOT to touch other files, so we don't reach into
// commands/dateShortcuts.ts for its private helpers).
// ====================================================================

/**
 * Get "now" rebased so its UTC fields read as Colombia local time (UTC-5).
 * The returned Date is intended for calendar arithmetic and for formatting
 * via the `getUTC*` accessors only.
 */
function nowInColombia(): Date {
  const now = new Date();
  return new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Format a date as "DD-MM-YYYY" using its UTC fields. Pair with
 * `nowInColombia()` so the UTC fields already reflect Colombia's local day.
 * This is the format the Bukeala /admin/daily endpoint expects.
 */
function dateToDdMmYyyy(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * Format a date as "DD/MM/YY" for the user-facing header — matches the
 * style produced by `dashedToFriendly()` in telegram.ts.
 */
function dateToFriendly(d: Date): string {
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${yy}`;
}

/**
 * Convert "08:00 AM" / "12:40 PM" / "01:00 PM" → minutes since midnight,
 * suitable for sorting. Returns NaN-safe 0 for unparseable inputs (so they
 * still sort somewhere stable instead of throwing).
 */
function timeKey(formatted: string): number {
  const m = formatted.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const isPm = m[3].toUpperCase() === "PM";
  if (h === 12) h = 0;
  if (isPm) h += 12;
  return h * 60 + min;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
