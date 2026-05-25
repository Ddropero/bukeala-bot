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
import type { AgendaBookingDoc } from "../agendaDoc";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

function tomorrowInBogota(): Date {
  const now = new Date();
  const bogota = new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
  bogota.setUTCDate(bogota.getUTCDate() + 1);
  return bogota;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** Bukeala /admin/daily expects DD-MM-YYYY (dashes). Slashes break the URL. */
function dateToDdMmYyyyDashed(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function dateToFriendly(d: Date): string {
  const day = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"][d.getUTCDay()];
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${day} ${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${yy}`;
}

function extractPhone(bk: AgendaBookingDoc): string {
  if (typeof bk.cellPhone === "string" && bk.cellPhone.trim()) return bk.cellPhone.trim();
  if (
    bk.cellPhone &&
    typeof bk.cellPhone === "object" &&
    typeof (bk.cellPhone as { phoneNumber?: string }).phoneNumber === "string"
  ) {
    return ((bk.cellPhone as { phoneNumber?: string }).phoneNumber ?? "").trim();
  }
  if (typeof bk.phone === "string" && bk.phone.trim()) return bk.phone.trim();
  if (typeof bk.customerPhone === "string" && bk.customerPhone.trim()) return bk.customerPhone.trim();
  return "";
}

export async function reminderCron(env: Env): Promise<void> {
  const s = await loadSession(env);
  if (!s) {
    console.log("[reminderCron] no session, skip");
    return;
  }
  const b = new Bukeala(env);
  const tomorrow = tomorrowInBogota();
  const dashed = dateToDdMmYyyyDashed(tomorrow);
  const friendly = dateToFriendly(tomorrow);
  console.log(`[reminderCron] fetching agenda for ${dashed}`);

  let bookings: AgendaBookingDoc[] = [];
  try {
    const res = await b.getAgenda(dashed, AREA_ID, /* includeCanceled */ false);
    const j = await res.json<any>().catch(() => null);
    bookings = (j?.areas?.[0]?.bookings ?? []) as AgendaBookingDoc[];
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.log("[reminderCron] session expired");
      return;
    }
    console.log("[reminderCron] fetch failed:", (e as Error).message);
    return;
  }

  const active = bookings.filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime);
  console.log(`[reminderCron] found ${active.length} active bookings for ${dashed}`);

  let sentCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  for (const bk of active) {
    const reservationCode = String(bk.id ?? "");
    const name = bk.name ?? "Paciente";
    const time12h = bk.startHourFormatted ?? "";
    const rawPhone = extractPhone(bk);

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
      env, phone, name, friendly, time12h, "Calle 80 # 10-43, Cons 506",
    );
    if (r.ok) {
      sentCount++;
      await env.STATE.put(sentKey, "1", { expirationTtl: 60 * 60 * 24 * 3 });
    } else {
      const err = (r as any).data?.error?.message ?? (r as any).reason ?? "unknown";
      errors.push(`${name} (${phone}): ${err}`);
    }
  }

  // Notify all authorized users with the daily summary
  const recipients = await getAllRecipients(env);
  const summary =
    `📲 <b>Recordatorios WhatsApp enviados</b> para ${friendly}\n\n` +
    `Total citas: ${active.length}\n` +
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
