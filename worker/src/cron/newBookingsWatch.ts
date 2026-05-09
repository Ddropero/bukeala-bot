/**
 * New-bookings watch cron handler.
 *
 * Polls AREA_ID = 1074 across the next 3 days (today, +1, +2) on every tick
 * and diffs the resulting set of active booking IDs against a snapshot kept
 * in KV under `bookingsSnapshot:current`. For each diff:
 *
 *   - IDs present now but not in the previous snapshot  → "🆕 Nueva cita"
 *   - IDs present in the previous snapshot but gone now → "❌ Cita cancelada"
 *
 * The snapshot also persists each booking's display fields so we can format
 * a meaningful cancellation message even though the booking will no longer
 * appear in `getAgenda` after it's canceled.
 *
 * First-run safety: if the snapshot is null (e.g. very first invocation,
 * or KV TTL expired), we just store the new snapshot and skip notifications
 * to avoid spamming the user with one "Nueva cita" per existing booking.
 *
 * Wiring contract (the integrator handles this in index.ts / wrangler.toml):
 *   - This module exports `newBookingsCheck(env)` only.
 *   - It does NOT register itself with the scheduler.
 *   - It assumes a *separate* cron entry like `*​/10 12-23 * * *` so that
 *     the existing keepAlive `*​/5` cron isn't doubled up.
 *
 * Failure tolerance:
 *   - If one of the 3 day fetches fails (network, parse, etc.), we log and
 *     continue with whatever days succeeded. We still diff and update the
 *     snapshot so the worst case is one cycle of missed notifications, not
 *     a permanent stuck snapshot.
 *   - If the session is missing/expired, we no-op silently — the keepAlive
 *     cron is responsible for telling the user to re-capture.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { getAllRecipients } from "../users";

// AREA_ID for the doctor's calendar — same constant used by /hoy, /agenda,
// and dailySummary.
const AREA_ID = 1074;

// Colombia is UTC-5 year-round (no DST).
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

// How many days ahead (inclusive of today) to scan. Bookings beyond this
// window won't trigger a notification on creation; that's intentional —
// most relevant changes are short-term.
const SCAN_DAYS = 3;

// KV key for the persisted snapshot. Single global key (not per-chat) since
// the bot has a single allowed user.
const SNAPSHOT_KEY = "bookingsSnapshot:current";

// 24h TTL: long enough to survive a quiet weekend, short enough that a
// truly stale snapshot eventually self-clears and triggers a clean restart
// on the next tick (which becomes a "first run" → no spam).
const SNAPSHOT_TTL_SECONDS = 60 * 60 * 24;

// ====================================================================
// Types
// ====================================================================

/**
 * Subset of the Bukeala booking shape we care about for diffing and
 * formatting. Mirrors the AgendaBooking type in telegram.ts but keeps
 * everything optional so a malformed entry can't crash the whole tick.
 */
type WatchBooking = {
  id?: number;
  bookingCode?: string;
  name?: string;
  identification?: string;
  identificationTypeShortCode?: string;
  startHourFormatted?: string;
  bookingComponentName?: string;
  planName?: string;
  isCanceled?: boolean;
  isBusyTime?: boolean;
  stateCode?: string;
};

/**
 * Snapshot row we persist. Keep just enough to render the cancellation
 * message — we don't want to bloat KV with the full booking blob.
 */
type SnapshotDetail = {
  /** Date the booking falls on, in DD-MM-YYYY form (matches getAgenda input). */
  date: string;
  name: string;
  identification: string;
  identificationTypeShortCode: string;
  startHourFormatted: string;
  bookingComponentName: string;
  planName: string;
  bookingCode: string;
};

type Snapshot = {
  /** ISO timestamp of when this snapshot was written. Useful for debug logs. */
  lastCheck: string;
  /** Sorted list of currently-active booking IDs across the scan window. */
  ids: number[];
  /** Per-id display details, keyed by stringified id (KV-friendly). */
  details: Record<string, SnapshotDetail>;
};

// ====================================================================
// Public API
// ====================================================================

export async function newBookingsCheck(env: Env): Promise<void> {
  // 1. No session → bail. Don't notify; keepAlive owns the "session expired"
  //    user message and we don't want to double up.
  const session = await loadSession(env);
  if (!session) {
    console.log("[newBookings] no session — skipping");
    return;
  }

  // 2. Build the 3-day window in Colombia time.
  const today = nowInColombia();
  const dates: string[] = [];
  for (let i = 0; i < SCAN_DAYS; i++) {
    dates.push(dateToDdMmYyyy(addDays(today, i)));
  }

  // 3. Fan out the 3 getAgenda calls in parallel. We use Promise.allSettled
  //    so one failed day doesn't poison the others; the error gets logged
  //    and that day contributes zero bookings to the diff.
  //
  //    Note: a SessionExpiredError on ANY day is treated as a global abort —
  //    once the session is gone, the other 2 calls would fail the same way,
  //    and we don't want a partial snapshot to overwrite the good one.
  const bukeala = new Bukeala(env);
  const settled = await Promise.allSettled(
    dates.map((d) => fetchDayBookings(bukeala, d)),
  );

  for (const r of settled) {
    if (r.status === "rejected" && r.reason instanceof SessionExpiredError) {
      console.log("[newBookings] session expired during scan — skipping (keepAlive will notify)");
      return;
    }
  }

  // 4. Collect active bookings (filter out canceled + busy-time) tagged with
  //    their date so the cancellation message can show "Mar 12/05/26".
  const currentDetails: Record<string, SnapshotDetail> = {};
  const currentIds: number[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const date = dates[i];
    if (result.status === "rejected") {
      console.log(`[newBookings] day ${date} failed: ${(result.reason as Error)?.message ?? result.reason}`);
      continue;
    }
    for (const bk of result.value) {
      if (bk.isCanceled) continue;
      if (bk.stateCode === "CANCELED") continue;
      if (bk.isBusyTime) continue;
      if (typeof bk.id !== "number") continue;
      if (currentDetails[String(bk.id)]) continue; // dedupe across days (paranoia)

      currentIds.push(bk.id);
      currentDetails[String(bk.id)] = {
        date,
        name: (bk.name ?? "").trim(),
        identification: (bk.identification ?? "").trim(),
        identificationTypeShortCode: (bk.identificationTypeShortCode ?? "").trim(),
        startHourFormatted: (bk.startHourFormatted ?? "").trim(),
        bookingComponentName: (bk.bookingComponentName ?? "").trim(),
        planName: (bk.planName ?? "").trim(),
        bookingCode: (bk.bookingCode ?? "").trim(),
      };
    }
  }
  currentIds.sort((a, b) => a - b);

  // 5. Load the previous snapshot. If absent → first run; just persist and
  //    bail without notifying.
  const previous = await loadSnapshot(env);
  const newSnapshot: Snapshot = {
    lastCheck: new Date().toISOString(),
    ids: currentIds,
    details: currentDetails,
  };

  if (!previous) {
    console.log(`[newBookings] first run — seeding snapshot with ${currentIds.length} bookings (no notifications)`);
    await saveSnapshot(env, newSnapshot);
    return;
  }

  // 6. Diff: sets of IDs.
  const prevIdSet = new Set(previous.ids);
  const currIdSet = new Set(currentIds);
  const newIds = currentIds.filter((id) => !prevIdSet.has(id));
  const goneIds = previous.ids.filter((id) => !currIdSet.has(id));

  console.log(
    `[newBookings] diff: +${newIds.length} new, -${goneIds.length} gone (current=${currentIds.length}, prev=${previous.ids.length})`,
  );

  // 7. Notify per delta. We send one message per booking — keeps each
  //    notification scannable on the phone, and Telegram has no batch UX
  //    benefit for small counts.
  // Broadcast new/canceled bookings to ALL authorized users (doctor + secretaries)
  const recipients = await getAllRecipients(env);
  for (const id of newIds) {
    const d = currentDetails[String(id)];
    if (!d) continue;
    const txt = formatNewBooking(d);
    for (const chatId of recipients) {
      await sendMessage(env, chatId, txt);
    }
  }
  for (const id of goneIds) {
    const d = previous.details[String(id)];
    if (!d) {
      console.log(`[newBookings] gone id=${id} but no details in previous snapshot — skipping notify`);
      continue;
    }
    const txt = formatCanceledBooking(d);
    for (const chatId of recipients) {
      await sendMessage(env, chatId, txt);
    }
  }

  // 8. Persist the new snapshot. We do this even if we sent zero messages
  //    so the lastCheck timestamp is fresh and the TTL is rolled forward.
  await saveSnapshot(env, newSnapshot);
}

// ====================================================================
// Bukeala fetch
// ====================================================================

/**
 * Single-day fetch. Returns the raw bookings array (may include canceled /
 * busy entries — we filter them at the call site so the snapshot diff sees
 * the same view as the user). Throws SessionExpiredError to abort the whole
 * cycle; logs and re-throws everything else for Promise.allSettled to handle.
 */
async function fetchDayBookings(bukeala: Bukeala, dateDashed: string): Promise<WatchBooking[]> {
  const res = await bukeala.getAgenda(dateDashed, AREA_ID, /* includeCanceled */ false);
  // res.json<T>() typings come from workers-types and accept a generic.
  const json = (await res
    .json<{ areas?: Array<{ bookings?: WatchBooking[] }> }>()
    .catch(() => null)) as { areas?: Array<{ bookings?: WatchBooking[] }> } | null;
  return json?.areas?.[0]?.bookings ?? [];
}

// ====================================================================
// KV snapshot
// ====================================================================

async function loadSnapshot(env: Env): Promise<Snapshot | null> {
  const raw = await env.STATE.get(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    // Defensive: older / partial snapshots without `details` shouldn't crash
    // the diff. Coerce to the expected shape.
    if (!parsed || !Array.isArray(parsed.ids)) return null;
    if (!parsed.details || typeof parsed.details !== "object") parsed.details = {};
    return parsed;
  } catch (err) {
    console.log(`[newBookings] snapshot parse error: ${(err as Error).message}`);
    return null;
  }
}

async function saveSnapshot(env: Env, snap: Snapshot): Promise<void> {
  await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(snap), {
    expirationTtl: SNAPSHOT_TTL_SECONDS,
  });
}

// ====================================================================
// Telegram
// ====================================================================

async function sendMessage(env: Env, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(
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
    console.log(`[newBookings] telegram sendMessage → ${res.status}`);
  } catch (err) {
    console.log(`[newBookings] telegram send failed: ${(err as Error).message}`);
  }
}

// ====================================================================
// Message formatting
// ====================================================================

/**
 * 🆕 Nueva cita
 * Cepeda Sanabria, Andrea
 * 📅 Mié 13/05/26 12:40 PM
 * 🩺 CIRUGIA PLASTICA Y RECONSTRUCTIVA PRESENCIAL
 * 🆔 CC 1234567890
 * 🔖 359688-422057
 */
function formatNewBooking(d: SnapshotDetail): string {
  const lines: string[] = [];
  lines.push("🆕 <b>Nueva cita</b>");
  lines.push(escapeHtml(d.name || "(sin nombre)"));
  lines.push(`📅 ${formatDateLine(d.date, d.startHourFormatted)}`);
  if (d.bookingComponentName) lines.push(`🩺 ${escapeHtml(d.bookingComponentName)}`);
  const docCombined = `${d.identificationTypeShortCode} ${d.identification}`.trim();
  if (docCombined) lines.push(`🆔 ${escapeHtml(docCombined)}`);
  if (d.bookingCode) lines.push(`🔖 ${escapeHtml(d.bookingCode)}`);
  return lines.join("\n");
}

/**
 * ❌ Cita cancelada
 * Pérez García, Juan
 * 📅 Mar 12/05/26 09:00 AM
 */
function formatCanceledBooking(d: SnapshotDetail): string {
  const lines: string[] = [];
  lines.push("❌ <b>Cita cancelada</b>");
  lines.push(escapeHtml(d.name || "(sin nombre)"));
  lines.push(`📅 ${formatDateLine(d.date, d.startHourFormatted)}`);
  return lines.join("\n");
}

/**
 * Compose the "📅" line: "Mié 13/05/26 12:40 PM".
 * - Day name: 3-letter Spanish abbreviation
 * - Date: DD/MM/YY (matches dashedToFriendly() in telegram.ts)
 * - Time: passed through verbatim (Bukeala already formats as "12:40 PM")
 */
function formatDateLine(dateDashed: string, time: string): string {
  const parts = parseDdMmYyyy(dateDashed);
  if (!parts) return `${dateDashed} ${time}`.trim();
  const { dd, mm, yyyy } = parts;
  const dayName = spanishDayShort(yyyy, mm, dd);
  const yy = String(yyyy).slice(2);
  const dateStr = `${pad2(dd)}/${pad2(mm)}/${yy}`;
  return `${dayName} ${dateStr}${time ? " " + time : ""}`;
}

// ====================================================================
// Date helpers
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

function addDays(d: Date, n: number): Date {
  // Use UTC math because the Colombia-rebased dates we operate on are
  // already meant to be read via getUTC*. Adding 86400000ms always shifts
  // to the next day regardless of DST (Colombia has none, but this keeps
  // the helper safe even if we ever feed it a non-rebased date).
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

function dateToDdMmYyyy(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function parseDdMmYyyy(s: string): { dd: number; mm: number; yyyy: number } | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return { dd: parseInt(m[1], 10), mm: parseInt(m[2], 10), yyyy: parseInt(m[3], 10) };
}

/**
 * Spanish 3-letter abbreviated day name for a given Y/M/D in Colombia time.
 * We compute the weekday from a UTC midnight Date; since Colombia has a
 * fixed offset, the day-of-week is the same whether you treat it as UTC
 * or local time.
 */
function spanishDayShort(yyyy: number, mm: number, dd: number): string {
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  const idx = date.getUTCDay(); // 0 = Sunday
  // Per the requested format: "Mié", "Mar", etc. (3 chars, accented Sáb/Mié).
  const names = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  return names[idx] ?? "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
