/**
 * Daily reminder cron — sends appointment_reminder template to every patient
 * with a booking ~24h away.
 *
 * Schedule: once per day at 7am Colombia (12pm UTC).
 *
 * Logic:
 *   1. Fetch tomorrow's agenda via Bukeala
 *   2. For each active booking with a valid phone, send appointment_reminder
 *   3. Throttle: avoid double-send by writing a "sentAt" mark to KV per booking
 *   4. Skip patients whose `wa:consent:{phone}` is "human" (they don't want AI)
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { sendAppointmentReminder, normalizeColombianPhone } from "../whatsapp";
import { getAllRecipients } from "../users";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

function tomorrowInBogotaDDMMYYYY(): string {
  const now = new Date();
  const bogota = new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
  bogota.setUTCDate(bogota.getUTCDate() + 1);
  const dd = String(bogota.getUTCDate()).padStart(2, "0");
  const mm = String(bogota.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = bogota.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function ddmmyyyyToFriendly(date: string): string {
  // "14/05/2026" → "Miércoles 14/05/26"
  const [dd, mm, yyyy] = date.split("/");
  const d = new Date(Date.UTC(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd)));
  const day = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"][d.getUTCDay()];
  return `${day} ${dd}/${mm}/${yyyy.slice(-2)}`;
}

export async function reminderCron(env: Env): Promise<void> {
  const s = await loadSession(env);
  if (!s) {
    console.log("[reminderCron] no session, skip");
    return;
  }
  const b = new Bukeala(env);
  const tomorrow = tomorrowInBogotaDDMMYYYY();
  const friendlyDate = ddmmyyyyToFriendly(tomorrow);
  console.log(`[reminderCron] fetching agenda for ${tomorrow}`);

  let bookings: any[];
  try {
    const res = await b.getAgenda(tomorrow, AREA_ID);
    const j = await res.json<any>();
    bookings = Array.isArray(j?.result) ? j.result : [];
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.log("[reminderCron] session expired");
      return;
    }
    console.log("[reminderCron] fetch failed:", (e as Error).message);
    return;
  }

  console.log(`[reminderCron] found ${bookings.length} bookings for ${tomorrow}`);

  let sentCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  for (const bk of bookings) {
    if (bk.stateCode && bk.stateCode !== "1") continue; // skip canceled
    const reservationCode = bk.reservationCode ?? bk.id;
    const name = bk.customerName ?? bk.name ?? "Paciente";
    const rawPhone = bk.customerPhone ?? bk.phone ?? "";
    const time12h = bk.time ?? bk.startTime ?? "";

    if (!rawPhone) { skippedCount++; continue; }
    const phone = normalizeColombianPhone(rawPhone);
    if (!phone || phone.length < 10) { skippedCount++; continue; }

    // Throttle: did we already send a reminder for this booking?
    const sentKey = `reminder:sent:${reservationCode}`;
    const already = await env.STATE.get(sentKey);
    if (already) { skippedCount++; continue; }

    // Respect patient consent: if they said "human", skip the auto reminder
    const consent = await env.STATE.get(`wa:consent:${phone}`);
    if (consent === "human") { skippedCount++; continue; }

    const r = await sendAppointmentReminder(
      env, phone, name, friendlyDate, time12h, "Calle 80 # 10-43, Cons 506",
    );
    if (r.ok) {
      sentCount++;
      await env.STATE.put(sentKey, "1", { expirationTtl: 60 * 60 * 24 * 3 });
    } else {
      const err = r.data?.error?.message ?? r.reason ?? "unknown";
      errors.push(`${name} (${phone}): ${err}`);
    }
  }

  // Notify all authorized users with the daily summary
  const recipients = await getAllRecipients(env);
  const summary =
    `📲 <b>Recordatorios WhatsApp enviados</b> para ${friendlyDate}\n\n` +
    `Total citas: ${bookings.length}\n` +
    `✅ Enviados: ${sentCount}\n` +
    `⏭️ Saltados (sin tel, ya enviado, o consent=human): ${skippedCount}\n` +
    (errors.length > 0 ? `❌ Errores: ${errors.length}\n${errors.slice(0, 5).map((e) => "• " + e).join("\n")}` : "");

  for (const chat of recipients) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: summary, parse_mode: "HTML" }),
      });
    } catch {
      // ignore
    }
  }
}
