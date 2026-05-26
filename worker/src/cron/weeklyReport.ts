/**
 * Weekly report cron — runs every Monday 7am Bogotá (12:00 UTC) and posts a
 * single Telegram summary covering the prior week (previous Monday → previous
 * Sunday) to every authorized user.
 *
 * Wiring (handled by parent — DO NOT touch here):
 *   - wrangler.toml: triggers.crons += "0 12 * * 1"
 *   - index.ts: scheduled() dispatch routes that cron to weeklyReport()
 *
 * Data sources:
 *   - Bukeala agenda (includeCanceled=true) — appointments + cancellations,
 *     per-day, anchored to Colombia time so weekend boundaries match what
 *     the doctor sees.
 *   - KV `quote:pending:list` — quote tickets created in the window
 *     (status: pending / quoted / accepted / rejected / expired).
 *   - KV `wa:contact:*` — unique WhatsApp patients whose lastSeenAt falls in
 *     the window (best-effort, single KV.list scan).
 *
 * Failure tolerance:
 *   - No session → notify doctors only, prompt to /sesion_renew, then abort.
 *   - Single-day fetch failure (network/parse) → skip that day, keep going.
 *   - SessionExpiredError mid-scan → notify and abort (don't send a partial
 *     report that under-counts the week).
 *   - Telegram send failures are logged but never thrown — one user being
 *     unreachable shouldn't block the others.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { getAllRecipients, getDoctorRecipients } from "../users";
import { loadSession } from "../kv";

// Doctor's area code in Bukeala — same constant used by dailySummary,
// reminderCron, and newBookingsWatch. Hard-coded on purpose: the bot serves
// a single doctor and getAgenda needs it as a query param.
const AREA_ID = 1074;

// Colombia is UTC-5 year-round (no DST). Anchoring to Bogotá time means the
// "week" we report on lines up with calendar weeks the doctor experiences,
// not arbitrary UTC midnights.
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

// QuoteTicket shape — kept local & minimal so we don't import from quotesBot
// (the task spec says we just use the shape). All fields we actually read
// here are required; the rest of the real interface is fine to ignore.
type QuoteStatus = "pending" | "quoted" | "accepted" | "rejected" | "expired";
type QuoteTicket = {
  id: string;
  fromPhone: string;
  status: QuoteStatus;
  createdAt: number;
  quotedAt?: number;
};

// Subset of the booking shape we read. Matches what dailySummary &
// newBookingsWatch parse out of `areas[0].bookings`.
type ReportBooking = {
  id?: number;
  stateCode?: string;
  isCanceled?: boolean;
  isBusyTime?: boolean;
  name?: string;
  startHourFormatted?: string;
};

// ====================================================================
// Public entry point
// ====================================================================

export async function weeklyReport(env: Env): Promise<void> {
  // 1. Build the date window: previous Monday → previous Sunday, both
  //    inclusive, in Bogotá time. Running Monday 7am, "yesterday" is
  //    Sunday and "7 days ago" is the prior Monday.
  const today = nowInColombia();
  const sunday = addDays(today, -1);   // previous Sunday
  const monday = addDays(today, -7);   // previous Monday

  const days: string[] = [];           // "DD-MM-YYYY" for Bukeala API
  for (let i = 0; i < 7; i++) {
    days.push(dateToDdMmYyyy(addDays(monday, i)));
  }
  const rangeStart = monday;
  const rangeEnd = sunday;
  // Window for filtering quote/WA timestamps. Start = monday 00:00 Bogotá,
  // end = sunday 23:59:59.999 Bogotá. We convert back to absolute ms.
  const windowStartMs = bogotaDayStartMs(monday);
  const windowEndMs = bogotaDayStartMs(addDays(sunday, 1)) - 1;

  // 2. Session check. Without a captured Bukeala session there's no way to
  //    pull the agenda, so notify the doctor(s) and bail. We use the
  //    doctor-only recipient list to avoid spamming secretaries with tech
  //    alerts — same pattern getDoctorRecipients exists for.
  const session = await loadSession(env);
  if (!session) {
    console.log("[weeklyReport] no session — notifying doctor and skipping");
    await broadcast(
      env,
      "⚠️ Reporte semanal no se pudo generar — Bukeala expirado. Renueva con /sesion_renew y reintenta.",
      /* doctorOnly */ true,
    );
    return;
  }

  // 3. Fetch all 7 days. We use includeCanceled=true so a single call per
  //    day yields BOTH active and canceled bookings; we partition them
  //    locally. Promise.allSettled means one bad day doesn't kill the rest;
  //    a SessionExpiredError on any day is treated as a global abort so we
  //    don't ship a partial week.
  const bukeala = new Bukeala(env);
  const settled = await Promise.allSettled(
    days.map((d) => fetchDayBookings(bukeala, d)),
  );

  for (const r of settled) {
    if (r.status === "rejected" && r.reason instanceof SessionExpiredError) {
      console.log("[weeklyReport] session expired mid-scan — notifying doctor and skipping");
      await broadcast(
        env,
        "⚠️ Reporte semanal no se pudo generar — Bukeala expirado. Renueva con /sesion_renew y reintenta.",
        /* doctorOnly */ true,
      );
      return;
    }
  }

  // 4. Aggregate appointment counts. We accept either `stateCode === "1"`
  //    (numeric, per task spec) OR the absence of `isCanceled` /
  //    `stateCode === "CANCELED"` markers used elsewhere in the codebase
  //    (dailySummary, newBookingsWatch). The two encodings come from
  //    different Bukeala endpoint variants — covering both is safer than
  //    betting on one.
  let activeTotal = 0;
  let canceledTotal = 0;
  const perDayActive: number[] = new Array(7).fill(0);

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "rejected") {
      console.log(`[weeklyReport] day ${days[i]} failed: ${(r.reason as Error)?.message ?? r.reason}`);
      continue;
    }
    for (const bk of r.value) {
      if (bk.isBusyTime) continue; // block-time entries don't count as appts
      if (isCanceled(bk)) {
        canceledTotal++;
      } else {
        activeTotal++;
        perDayActive[i]++;
      }
    }
  }

  // 5. Quote metrics — filter by createdAt in window.
  const quoteStats = await aggregateQuotes(env, windowStartMs, windowEndMs);

  // 6. WhatsApp unique conversations — best-effort scan of wa:contact:* keys.
  const uniquePatients = await countActiveContacts(env, windowStartMs, windowEndMs);

  // 7. Format & send.
  const text = formatReport({
    rangeStart,
    rangeEnd,
    activeTotal,
    canceledTotal,
    quotes: quoteStats,
    uniquePatients,
  });

  await broadcast(env, text, /* doctorOnly */ false);
}

// ====================================================================
// Bukeala fetch (one day)
// ====================================================================

/**
 * Single-day fetch. Returns the raw bookings list (both active + canceled
 * because we passed includeCanceled=true). SessionExpiredError bubbles up
 * for the caller to detect; other errors are caught and turned into an
 * empty list with a log so the week's total isn't blocked by one flaky day.
 */
async function fetchDayBookings(b: Bukeala, dateDashed: string): Promise<ReportBooking[]> {
  try {
    const res = await b.getAgenda(dateDashed, AREA_ID, /* includeCanceled */ true);
    const json = (await res
      .json<{ areas?: Array<{ bookings?: ReportBooking[] }>; result?: ReportBooking[] }>()
      .catch(() => null)) as
      | { areas?: Array<{ bookings?: ReportBooking[] }>; result?: ReportBooking[] }
      | null;
    // Endpoint returns `{ areas: [{ bookings }] }` in the daily-list shape
    // used by /agenda. Fall back to `result` for any other variant.
    const bookings = json?.areas?.[0]?.bookings ?? json?.result ?? [];
    return Array.isArray(bookings) ? bookings : [];
  } catch (e) {
    if (e instanceof SessionExpiredError) throw e;
    console.log(`[weeklyReport] fetchDayBookings(${dateDashed}) error: ${(e as Error).message}`);
    return [];
  }
}

function isCanceled(bk: ReportBooking): boolean {
  if (bk.isCanceled) return true;
  if (bk.stateCode === "CANCELED") return true;
  // The reminderCron treats stateCode "1" as active; anything else (and
  // present) as not active. Only apply this rule if stateCode is set and
  // not one of the strings we already handled.
  if (typeof bk.stateCode === "string" && bk.stateCode !== "" && bk.stateCode !== "1" && bk.stateCode !== "CANCELED") {
    return true;
  }
  return false;
}

// ====================================================================
// Quote metrics
// ====================================================================

type QuoteStats = {
  requested: number;  // total tickets created in window
  sent: number;       // quoted + accepted + rejected (i.e. Andrea actually replied)
  accepted: number;
  rejected: number;
  pending: number;
  conversionPct: number | null; // accepted / sent * 100, or null if sent==0
};

async function aggregateQuotes(
  env: Env,
  windowStartMs: number,
  windowEndMs: number,
): Promise<QuoteStats> {
  const empty: QuoteStats = {
    requested: 0, sent: 0, accepted: 0, rejected: 0, pending: 0, conversionPct: null,
  };
  const raw = await env.STATE.get("quote:pending:list");
  if (!raw) return empty;

  let list: QuoteTicket[];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.log(`[weeklyReport] quote list parse error: ${(err as Error).message}`);
    return empty;
  }

  const inWindow = list.filter(
    (t) => typeof t?.createdAt === "number" && t.createdAt >= windowStartMs && t.createdAt <= windowEndMs,
  );

  let accepted = 0, rejected = 0, pending = 0, sent = 0;
  for (const t of inWindow) {
    switch (t.status) {
      case "accepted":
        accepted++;
        sent++;
        break;
      case "rejected":
        rejected++;
        sent++;
        break;
      case "quoted":
        sent++;
        break;
      case "pending":
        pending++;
        break;
      // "expired" — counted in requested but neither sent nor pending.
    }
  }

  return {
    requested: inWindow.length,
    sent,
    accepted,
    rejected,
    pending,
    conversionPct: sent > 0 ? Math.round((accepted / sent) * 100) : null,
  };
}

// ====================================================================
// WhatsApp unique conversation count
// ====================================================================

/**
 * Count distinct phones that had wa:contact:{phone}.lastSeenAt inside the
 * window. Cursor-paginated so we don't drop contacts if the namespace grows
 * past a single list() page (default 1000). Failure is logged + returns 0.
 */
async function countActiveContacts(
  env: Env,
  windowStartMs: number,
  windowEndMs: number,
): Promise<number> {
  try {
    let cursor: string | undefined = undefined;
    const seen = new Set<string>();
    // Safety cap: 20 pages × 1000 = 20k phones. Way beyond any realistic
    // patient base for a single-doctor practice, but prevents infinite
    // loops if the KV API ever returns a non-terminating cursor.
    for (let page = 0; page < 20; page++) {
      const res: { keys: { name: string }[]; list_complete?: boolean; cursor?: string } =
        await env.STATE.list({ prefix: "wa:contact:", cursor });
      for (const k of res.keys) {
        const phone = k.name.slice("wa:contact:".length);
        const raw = await env.STATE.get(k.name);
        if (!raw) continue;
        try {
          const info = JSON.parse(raw) as { lastSeenAt?: number };
          if (typeof info?.lastSeenAt !== "number") continue;
          if (info.lastSeenAt >= windowStartMs && info.lastSeenAt <= windowEndMs) {
            seen.add(phone);
          }
        } catch {
          // bad json — ignore this contact
        }
      }
      if (res.list_complete || !res.cursor) break;
      cursor = res.cursor;
    }
    return seen.size;
  } catch (e) {
    console.log(`[weeklyReport] countActiveContacts error: ${(e as Error).message}`);
    return 0;
  }
}

// ====================================================================
// Message formatting
// ====================================================================

type FormatInput = {
  rangeStart: Date;       // Bogotá-rebased Date for Monday
  rangeEnd: Date;         // Bogotá-rebased Date for Sunday
  activeTotal: number;
  canceledTotal: number;
  quotes: QuoteStats;
  uniquePatients: number;
};

function formatReport(input: FormatInput): string {
  const startStr = `${pad2(input.rangeStart.getUTCDate())}/${pad2(input.rangeStart.getUTCMonth() + 1)}`;
  const endStr = `${pad2(input.rangeEnd.getUTCDate())}/${pad2(input.rangeEnd.getUTCMonth() + 1)}`;
  const weekNum = isoWeekNumber(input.rangeStart);

  const lines: string[] = [];
  lines.push("📊 <b>Reporte semanal</b>");
  lines.push(`${startStr} - ${endStr} (semana ${weekNum})`);
  lines.push("");
  lines.push("📅 <b>Citas</b>");
  lines.push(`✅ Activas: ${input.activeTotal}`);
  lines.push(`❌ Canceladas: ${input.canceledTotal}`);
  lines.push("");
  lines.push("💰 <b>Cotizaciones</b>");
  lines.push(`📨 Solicitadas: ${input.quotes.requested}`);
  lines.push(`📤 Enviadas: ${input.quotes.sent}`);
  if (input.quotes.conversionPct !== null) {
    lines.push(`✅ Aceptadas: ${input.quotes.accepted} (${input.quotes.conversionPct}%)`);
  } else {
    lines.push(`✅ Aceptadas: ${input.quotes.accepted}`);
  }
  lines.push(`⏳ Pendientes: ${input.quotes.pending}`);
  lines.push("");
  lines.push("🤖 <b>Conversaciones WhatsApp</b>");
  lines.push(`💬 Pacientes únicos: ${input.uniquePatients}`);

  return lines.join("\n");
}

// ====================================================================
// Telegram send
// ====================================================================

/**
 * Fan out a Telegram message to recipients. `doctorOnly=true` is used for
 * tech alerts (session-expired) so secretaries don't get noise.
 */
async function broadcast(env: Env, text: string, doctorOnly: boolean): Promise<void> {
  let recipients: string[];
  try {
    recipients = doctorOnly
      ? await getDoctorRecipients(env)
      : await getAllRecipients(env);
  } catch (e) {
    console.log(`[weeklyReport] recipients lookup failed: ${(e as Error).message}`);
    return;
  }

  for (const chatId of recipients) {
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
      console.log(`[weeklyReport] sent → chat=${chatId} status=${res.status}`);
    } catch (err) {
      console.log(`[weeklyReport] send failed chat=${chatId}: ${(err as Error).message}`);
    }
  }
}

// ====================================================================
// Date helpers (Bogotá / UTC-5)
// ====================================================================

/**
 * "Now" rebased so getUTC* accessors read as Bogotá local time. Pair every
 * formatter (dateToDdMmYyyy, etc.) with this so they're consistent.
 */
function nowInColombia(): Date {
  const now = new Date();
  return new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

/**
 * Format a Bogotá-rebased Date as the "DD-MM-YYYY" Bukeala API expects.
 */
function dateToDdMmYyyy(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * Absolute ms timestamp for 00:00:00 Bogotá time on the day the given
 * (Bogotá-rebased) Date represents. We rebuild the wall-clock date from the
 * rebased Date's UTC fields, then shift back by the Bogotá offset to land
 * on the real instant.
 *
 *   bogotaDayStartMs(rebasedMonday) → real ms for Mon 00:00 -05:00
 */
function bogotaDayStartMs(d: Date): number {
  const wallClockMidnightUTC = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
  );
  // Subtract the offset (which is negative for UTC-5) to map Bogotá midnight
  // to its real UTC instant.
  return wallClockMidnightUTC - COLOMBIA_OFFSET_MINUTES * 60 * 1000;
}

/**
 * ISO 8601 week number for a Bogotá-rebased Date. Standard "Thursday of the
 * same week" algorithm — Monday-based weeks, week containing the year's
 * first Thursday is week 1.
 */
function isoWeekNumber(d: Date): number {
  // Copy UTC fields into a fresh UTC Date so the math doesn't drift.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Day of week 1..7 (Mon..Sun). getUTCDay() returns 0..6 (Sun..Sat).
  const dayNum = tmp.getUTCDay() || 7;
  // Shift to the Thursday of the same ISO week.
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  // Jan 1 of that year.
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  // Weeks since yearStart (rounded up).
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
