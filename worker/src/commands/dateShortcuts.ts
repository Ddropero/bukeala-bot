/**
 * Date shortcut commands for the Bukeala Telegram bot.
 *
 *   /hoy     → agenda for today
 *   /manana  → agenda for tomorrow
 *   /semana  → 7-day summary with active booking counts per day
 *
 * Plus a helper to resolve weekday abbreviations (lun, mar, mie, jue, vie,
 * sab, dom) to the next-occurring date, used to support
 *   /agenda mie   → agenda of the next Wednesday
 *
 * All "current time" reasoning is anchored to Colombia time (UTC-5, no DST).
 *
 * NOTE: this module imports `showAgenda` from "../telegram"; the integrator
 * must export that helper from telegram.ts when wiring this module in.
 */
import type { Env } from "../env";
import { Bukeala } from "../bukeala";
import { showAgenda, sendMessage } from "../telegram";

// ====================================================================
// Constants
// ====================================================================
const AREA_ID = 1074;

// Colombia is UTC-5 year-round (no DST).
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

// Spanish weekday abbreviations → ISO weekday (Monday=1, Sunday=7).
const WEEKDAY_ABBREV: Record<string, number> = {
  lun: 1,
  mar: 2,
  mie: 3,
  jue: 4,
  vie: 5,
  sab: 6,
  dom: 7,
};

// Display labels for the weekly summary.
const WEEKDAY_LABEL_SHORT: Record<number, string> = {
  1: "Lun",
  2: "Mar",
  3: "Mié",
  4: "Jue",
  5: "Vie",
  6: "Sáb",
  7: "Dom",
};

// ====================================================================
// Public API
// ====================================================================

/** /hoy — show agenda for today (Colombia time). */
export async function handleHoy(env: Env, chatId: string): Promise<void> {
  const today = nowInColombia();
  await showAgenda(env, chatId, dateToDdMmYyyy(today));
}

/** /manana — show agenda for tomorrow (Colombia time). */
export async function handleManana(env: Env, chatId: string): Promise<void> {
  const tomorrow = addDays(nowInColombia(), 1);
  await showAgenda(env, chatId, dateToDdMmYyyy(tomorrow));
}

/**
 * /semana — brief summary of the next 7 days starting from today (Colombia
 * time). Fetches all 7 agendas in parallel and reports active-booking
 * counts per day.
 *
 * Active = not canceled AND not a busy-time block.
 */
export async function handleSemana(env: Env, chatId: string): Promise<void> {
  const start = nowInColombia();
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(addDays(start, i));
  }

  const bukeala = new Bukeala(env);
  const results = await Promise.all(
    days.map(async (d) => {
      const dashed = dateToDdMmYyyy(d);
      try {
        const res = await bukeala.getAgenda(dashed, AREA_ID, false);
        const json = (await res.json<any>().catch(() => null)) as any;
        const bookings: any[] = json?.areas?.[0]?.bookings ?? [];
        const active = bookings.filter(
          (bk) =>
            !bk?.isCanceled &&
            bk?.stateCode !== "CANCELED" &&
            !bk?.isBusyTime,
        );
        return { date: d, count: active.length, hasAgenda: true };
      } catch (err) {
        console.log(
          `[semana] error fetching ${dashed}: ${(err as Error).message}`,
        );
        return { date: d, count: 0, hasAgenda: false };
      }
    }),
  );

  const lines: string[] = ["<b>Resumen semana</b>"];
  for (const r of results) {
    const isoDay = isoWeekday(r.date);
    const label = WEEKDAY_LABEL_SHORT[isoDay] ?? "?";
    const ddmm = `${pad2(r.date.getUTCDate())}/${pad2(r.date.getUTCMonth() + 1)}`;
    if (!r.hasAgenda || r.count === 0) {
      lines.push(`${label} ${ddmm}: sin agenda`);
    } else {
      const noun = r.count === 1 ? "cita" : "citas";
      lines.push(`${label} ${ddmm}: ${r.count} ${noun}`);
    }
  }

  await sendMessage(env, chatId, lines.join("\n"));
}

/**
 * Resolve a Spanish weekday abbreviation to the date of the NEXT occurrence
 * in `DD-MM-YYYY` format (dashed, day first — matches Bukeala /agenda input).
 *
 * "Próximo" means the NEXT occurrence: if today is Wednesday and the input
 * is "mie", returns the date 7 days from now (the next Wednesday), not today.
 *
 * Accepted abbrevs (case-insensitive, accents stripped): lun, mar, mie, jue,
 * vie, sab, dom. Returns null for any other input.
 *
 * Anchored to Colombia time (UTC-5).
 */
export function nextWeekdayDateFromAbbrev(abbrev: string): string | null {
  if (!abbrev) return null;
  const normalized = abbrev
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  const target = WEEKDAY_ABBREV[normalized];
  if (!target) return null;

  const today = nowInColombia();
  const todayIso = isoWeekday(today);

  // Always advance — "próximo" means the NEXT occurrence, even if today
  // already matches the requested weekday.
  let delta = target - todayIso;
  if (delta <= 0) delta += 7;

  return dateToDdMmYyyy(addDays(today, delta));
}

// ====================================================================
// Internal date helpers
// ====================================================================

/**
 * Format a Date as "DD-MM-YYYY" using its UTC fields. Pair with
 * `nowInColombia()` / `addDays()` so the UTC fields already reflect the
 * Colombia local calendar day.
 */
function dateToDdMmYyyy(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Add N whole days to a date, returning a new Date. */
function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Return the Monday of the ISO week that contains `d`. Operates on UTC
 * fields, so pair with dates produced by `nowInColombia()` / `addDays()`.
 */
function getMondayOf(d: Date): Date {
  const iso = isoWeekday(d); // 1..7, Monday=1
  return addDays(d, -(iso - 1));
}

/**
 * Get the "now" instant rebased so its UTC fields read as Colombia local
 * time (UTC-5). The returned Date is intended for calendar arithmetic and
 * formatting via the `getUTC*` accessors only.
 */
function nowInColombia(): Date {
  const now = new Date();
  return new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

/**
 * ISO weekday (Monday=1 ... Sunday=7) of a date, read from its UTC fields.
 * Use with dates produced by `nowInColombia()` / `addDays()`.
 */
function isoWeekday(d: Date): number {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Re-export `getMondayOf` so future callers (e.g. weekly views starting on
// Monday rather than today) can use it without re-implementing the math.
export { getMondayOf };
