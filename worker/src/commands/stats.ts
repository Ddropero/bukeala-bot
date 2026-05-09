/**
 * /stats — weekly statistics for the doctor's agenda.
 *
 * Compares the current ISO week (Mon–Sun) with the previous one. Reports:
 *   • Active appointments (not canceled, not busy-time blocks)
 *   • Cancellations
 *   • Occupancy = occupied slots / (open days × 15 slots/day),
 *     where an "open day" is one with ≥1 active or canceled booking
 *     and 15 = (WORK_END_HOUR − WORK_START_HOUR) × (60 / SLOT_MINUTES)
 *   • Peak day of the current week
 *   • % delta vs previous week
 *
 * Fetches all 14 days in parallel via Promise.all. If a single day's call
 * fails with SessionExpiredError it is silently dropped (treated as "sin
 * datos"); if EVERY call fails the user is told the Bukeala session expired.
 *
 * Times are anchored to Colombia (UTC-5, no DST), matching dateShortcuts.ts.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";

// ====================================================================
// Constants — kept in sync with telegram.ts (do NOT edit that file)
// ====================================================================
const AREA_ID = 1074;
const WORK_START_HOUR = 8;   // 8:00 AM
const WORK_END_HOUR = 13;    // 1:00 PM
const SLOT_MINUTES = 20;
const SLOTS_PER_DAY =
  ((WORK_END_HOUR - WORK_START_HOUR) * 60) / SLOT_MINUTES; // 15

// Colombia is UTC-5 year-round (no DST).
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

// ====================================================================
// Public API
// ====================================================================
export async function showWeeklyStats(env: Env, chatId: string): Promise<void> {
  const today = nowInColombia();
  const mondayThis = getMondayOf(today);
  const mondayPrev = addDays(mondayThis, -7);

  // Build 14 dates: previous week (0..6) + current week (7..13).
  const allDays: { date: Date; bucket: "prev" | "curr" }[] = [];
  for (let i = 0; i < 7; i++) allDays.push({ date: addDays(mondayPrev, i), bucket: "prev" });
  for (let i = 0; i < 7; i++) allDays.push({ date: addDays(mondayThis, i), bucket: "curr" });

  const bukeala = new Bukeala(env);

  type DayResult = {
    date: Date;
    bucket: "prev" | "curr";
    active: number;
    canceled: number;
    /** True iff the day has data (call succeeded). */
    hasData: boolean;
    /** True iff the day has ≥1 active or canceled booking. */
    isOpen: boolean;
  };

  const results: DayResult[] = await Promise.all(
    allDays.map(async ({ date, bucket }) => {
      const dashed = dateToDdMmYyyy(date);
      try {
        const res = await bukeala.getAgenda(dashed, AREA_ID, /* includeCanceled */ true);
        const json = (await res.json<any>().catch(() => null)) as any;
        const bookings: any[] = json?.areas?.[0]?.bookings ?? [];
        let active = 0;
        let canceled = 0;
        for (const bk of bookings) {
          if (bk?.isBusyTime) continue;
          if (bk?.isCanceled === true || bk?.stateCode === "CANCELED") {
            canceled++;
          } else {
            active++;
          }
        }
        return {
          date,
          bucket,
          active,
          canceled,
          hasData: true,
          isOpen: active + canceled > 0,
        };
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          console.log(`[stats] session expired fetching ${dashed}`);
          return { date, bucket, active: 0, canceled: 0, hasData: false, isOpen: false };
        }
        console.log(`[stats] error fetching ${dashed}: ${(err as Error).message}`);
        return { date, bucket, active: 0, canceled: 0, hasData: false, isOpen: false };
      }
    }),
  );

  // If EVERY day failed → session is gone; bail out with friendly message.
  if (results.every((r) => !r.hasData)) {
    await sendMessage(env, chatId, "⚠️ Sesión Bukeala expirada");
    return;
  }

  const curr = results.filter((r) => r.bucket === "curr");
  const prev = results.filter((r) => r.bucket === "prev");

  const sum = (arr: DayResult[], key: "active" | "canceled") =>
    arr.reduce((a, r) => a + r[key], 0);

  const currActive = sum(curr, "active");
  const currCanceled = sum(curr, "canceled");
  const prevActive = sum(prev, "active");
  const prevCanceled = sum(prev, "canceled");

  // Occupancy: only count days that actually had agenda open. If no day
  // is open we report 0% rather than dividing by zero.
  const occupancy = (arr: DayResult[]): number => {
    const openDays = arr.filter((r) => r.isOpen).length;
    if (openDays === 0) return 0;
    const occupiedSlots = sum(
      arr.filter((r) => r.isOpen),
      "active",
    );
    return Math.round((occupiedSlots / (openDays * SLOTS_PER_DAY)) * 100);
  };

  const currOcc = occupancy(curr);
  const prevOcc = occupancy(prev);

  // Peak day of current week (most active bookings; ties → first match).
  let peak: DayResult | null = null;
  for (const r of curr) {
    if (r.active === 0) continue;
    if (!peak || r.active > peak.active) peak = r;
  }

  const sundayThis = addDays(mondayThis, 6);
  const sundayPrev = addDays(mondayPrev, 6);

  const lines: string[] = [
    `📊 <b>Estadísticas</b>`,
    ``,
    `<b>Esta semana</b> (${dateToShort(mondayThis)} - ${dateToShort(sundayThis)})`,
    `• ${currActive} citas pendientes`,
    `• ${currCanceled} canceladas`,
    `• ${currOcc}% ocupación`,
  ];
  if (peak) {
    const noun = peak.active === 1 ? "cita" : "citas";
    lines.push(
      `• Pico: ${weekdayShort(peak.date)} ${dateToShort(peak.date)} con ${peak.active} ${noun}`,
    );
  } else {
    lines.push(`• Pico: sin datos`);
  }
  lines.push(``);
  lines.push(
    `<b>Semana pasada</b> (${dateToShort(mondayPrev)} - ${dateToShort(sundayPrev)})`,
  );
  lines.push(`• ${prevActive} citas`);
  lines.push(`• ${prevCanceled} canceladas`);
  lines.push(`• ${prevOcc}% ocupación`);
  lines.push(``);
  lines.push(`<b>Δ vs semana pasada</b>`);
  lines.push(`• Citas: ${formatDelta(currActive, prevActive, /* moreIsGood */ true)}`);
  lines.push(
    `• Cancelaciones: ${formatDelta(currCanceled, prevCanceled, /* moreIsGood */ false)}`,
  );

  await sendMessage(env, chatId, lines.join("\n"));
}

// ====================================================================
// Internal helpers
// ====================================================================

/**
 * Format a percentage delta with an arrow emoji. `moreIsGood` flips the
 * arrow choice for "bad" metrics like cancellations (down is good).
 *
 * Special cases:
 *   • Both zero → "0%"
 *   • Was zero, now nonzero → "+∞%" with the appropriate arrow
 */
function formatDelta(current: number, previous: number, moreIsGood: boolean): string {
  if (previous === 0 && current === 0) return "0%";
  if (previous === 0) {
    const arrow = moreIsGood ? "📈" : "📉";
    return `+∞% ${arrow}`;
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  const sign = pct > 0 ? "+" : "";
  let arrow: string;
  if (pct > 0) {
    arrow = moreIsGood ? "📈" : "📉";
  } else if (pct < 0) {
    arrow = moreIsGood ? "📉" : "📈";
  } else {
    arrow = "➖";
  }
  return `${sign}${pct}% ${arrow}`;
}

/** Format Date as "DD-MM-YYYY" using its UTC fields. */
function dateToDdMmYyyy(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Format Date as "DD/MM" using its UTC fields. */
function dateToShort(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`;
}

/** Add N whole days, returning a new Date. */
function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Monday of the ISO week containing `d`. */
function getMondayOf(d: Date): Date {
  const iso = isoWeekday(d);
  return addDays(d, -(iso - 1));
}

/** ISO weekday: Monday=1 … Sunday=7 (read from UTC fields). */
function isoWeekday(d: Date): number {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

/** "Now" rebased so its UTC fields read as Colombia local time. */
function nowInColombia(): Date {
  return new Date(Date.now() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

const WEEKDAY_LABEL_SHORT: Record<number, string> = {
  1: "Lun",
  2: "Mar",
  3: "Mié",
  4: "Jue",
  5: "Vie",
  6: "Sáb",
  7: "Dom",
};

function weekdayShort(d: Date): string {
  return WEEKDAY_LABEL_SHORT[isoWeekday(d)] ?? "?";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Local sendMessage — direct fetch to Telegram Bot API. Defined here to
 * keep this module self-contained per the task spec (must not import from
 * telegram.ts).
 */
async function sendMessage(env: Env, chat_id: string, text: string): Promise<void> {
  await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML" }),
  });
}
