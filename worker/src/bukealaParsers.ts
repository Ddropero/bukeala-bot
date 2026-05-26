/**
 * Shared parsers + helpers for Bukeala responses.
 *
 * Extracted so both the Telegram flow (telegram.ts) and the WhatsApp AI
 * agent (claudeBookingAgent.ts) can use the same logic. The Telegram file
 * still keeps its own copies for backward compatibility — DO NOT remove
 * those without testing the full /buscar flow.
 */

// Branch / area constants for this single-doctor bot.
export const BRANCH_CODE = "7960";
export const AREA_CODE = "80040718";
export const AREA_ID = 1074;

export const SPANISH_MONTHS: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

export type Slot = {
  bookingComponentId: number;
  bookingComponentCode: string;
  branchCode: string;
  areaId: number;
  areaCode: string;
  dateFormatted: string; // DD/MM/YY
  timeInSeconds: number;
  duration: number;
  label: string;
};

export type BookingCard = {
  reservationCode: string;
  status: string;
  weekday: string;
  date: string;
  time: string;
  component: string;
  plan: string;
};

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function secondsToHHMM(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
}

export function secondsToHHMM12h(s: number): string {
  const h24 = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const period = h24 < 12 ? "AM" : "PM";
  return `${h12}:${pad2(m)} ${period}`;
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function stripHtmlTags(s: string): string {
  return decodeHtml(String(s).replace(/<[^>]+>/g, "").trim());
}

function textOf(html: string, re: RegExp): string {
  const m = html.match(re);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}

/** "Miércoles 6 de Mayo" + year=2026 → "06/05/26" */
export function dayInLettersToDDMMYY(s: string, year: number): string {
  if (!s) return "";
  const m = s.match(/(\d+)\s+de\s+(\w+)/i);
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const month = SPANISH_MONTHS[m[2].toLowerCase()] ?? "01";
  const yy = String(year).slice(-2);
  return `${day}/${month}/${yy}`;
}

/**
 * Parse the doSearch JSON response into Slot objects (max 24).
 */
export function parseSlots(
  json: any,
  ctx: { componentCode: string; year: number },
): Slot[] {
  if (!json || typeof json !== "object") return [];

  const dayBuckets: Array<{ schedules: any[]; dateFormatted: string }> = [];
  for (const i of [1, 2, 3]) {
    const schedules = json[`schedulesDay${i}`];
    const dayInLetters = json[`day${i}Formatted`];
    if (Array.isArray(schedules) && schedules.length > 0 && dayInLetters) {
      const ddmmyy = dayInLettersToDDMMYY(dayInLetters, ctx.year);
      dayBuckets.push({ schedules, dateFormatted: ddmmyy });
    }
  }
  for (const i of [1, 2, 3]) {
    const grouped = json[`schedulesDayGrouped${i}`];
    if (Array.isArray(grouped)) {
      for (const g of grouped) {
        const inner = Array.isArray(g?.schedules) ? g.schedules : [];
        const dayInLetters = g?.dateFormatted ?? json[`day${i}Formatted`];
        if (inner.length > 0 && dayInLetters) {
          const ddmmyy = dayInLettersToDDMMYY(dayInLetters, ctx.year);
          dayBuckets.push({ schedules: inner, dateFormatted: ddmmyy });
        }
      }
    }
  }

  const out: Slot[] = [];
  for (const bucket of dayBuckets) {
    for (const s of bucket.schedules) {
      const time = Number(s.timeInSeconds ?? s.bookingTime ?? 0);
      const durationSec = Number(s.durationInSeconds ?? 0);
      const duration = Math.round(durationSec / 60) || Number(s.duration ?? 20);
      const label = `${bucket.dateFormatted} ${secondsToHHMM(time)}`;
      out.push({
        bookingComponentId: Number(s.componentId ?? s.bookingComponentId ?? 0),
        bookingComponentCode: ctx.componentCode,
        branchCode: BRANCH_CODE,
        areaId: Number(s.areaId ?? 0),
        areaCode: AREA_CODE,
        dateFormatted: bucket.dateFormatted,
        timeInSeconds: time,
        duration,
        label,
      });
    }
  }
  return out
    .filter((s) => s.bookingComponentId && s.areaId && s.dateFormatted && s.timeInSeconds)
    .slice(0, 24);
}

/** Parse the /myBookings HTML into BookingCard objects. */
export function parseBookingsFromMyBookings(html: string): BookingCard[] {
  const out: BookingCard[] = [];
  const containerRe = /<div class="booking-card-container"[^>]*id="item([\d-]+)"[^>]*>([\s\S]*?)(?=<div class="booking-card-container"|<\/main>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = containerRe.exec(html))) {
    const reservationCode = m[1];
    const block = m[2];
    out.push({
      reservationCode,
      status: textOf(block, /<p class="status">\s*([\s\S]*?)\s*<\/p>/),
      weekday: textOf(block, /<p class="weekday">\s*([\s\S]*?)\s*<\/p>/),
      date: textOf(block, /<p class="date">\s*([\s\S]*?)\s*<\/p>/),
      time: textOf(block, /<p class="time">\s*([\s\S]*?)\s*<\/p>/),
      plan: textOf(block, /<p class="plan">\s*([\s\S]*?)\s*<\/p>/),
      component: textOf(block, /<p class="component">\s*([\s\S]*?)\s*<\/p>/),
    });
  }
  return out;
}

/** Parse contact (email, phone) from the /booking/assign confirmation HTML. */
export function parseContactFromAssign(html: string): { email: string; phone: string } {
  let email = "";
  const emailPatterns = [
    /id="customerEmail"[^>]*value="([^"]+)"/,
    /id="email"[^>]*value="([^"]+)"/,
    /name="email"[^>]*value="([^"]+)"/,
    /data-customer-email="([^"]+)"/,
  ];
  for (const re of emailPatterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].includes("@")) { email = m[1]; break; }
  }
  let phone = "";
  const phonePatterns = [
    /id="cellPhone"[^>]*value="([+0-9\s-]+)"/,
    /id="customerCellPhone"[^>]*value="([+0-9\s-]+)"/,
    /name="cellPhone"[^>]*value="([+0-9\s-]+)"/,
    /data-customer-phone="([+0-9\s-]+)"/,
    /data-customer-cellphone="([+0-9\s-]+)"/,
    /data-number="([+0-9\s-]+)"/,
  ];
  for (const re of phonePatterns) {
    const m = html.match(re);
    if (m && m[1]) {
      phone = m[1].replace(/[^\d]/g, "");
      if (phone.length > 10 && phone.startsWith("57")) phone = phone.slice(2);
      if (phone.length >= 7) break;
    }
  }
  return { email, phone };
}

export function ddmmyyyy(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** "DD/MM/YYYY" → "DD/MM/YY" */
export function fourDigitYearToTwo(s: string): string {
  return s.replace(/(\d{2})\/(\d{2})\/\d{2}(\d{2})$/, "$1/$2/$3");
}
