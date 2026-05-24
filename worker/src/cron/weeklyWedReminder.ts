/**
 * Weekly Tuesday 6 PM Colombia cron — sends the "appointment_reminder"
 * WhatsApp template to every patient who has a booking on the upcoming
 * Wednesday.
 *
 * Schedule: "0 23 * * 2"  (23:00 UTC Tuesday = 6 PM Colombia Tuesday)
 *
 * Throttle: KV key `wed-reminder:sent:{reservationCode}` with 3-day TTL
 * prevents double-sends if the cron is invoked twice. We use a different
 * KV prefix than reminderCron (which uses `reminder:sent:`) so the two
 * reminders coexist as the doctor requested.
 *
 * Consent: patients flagged `wa:consent:{phone} == "human"` are skipped.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { sendAppointmentReminder, normalizeColombianPhone } from "../whatsapp";
import { getDoctorRecipients } from "../users";
import type { AgendaBookingDoc } from "../agendaDoc";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MINUTES = -5 * 60;

function nowInColombia(): Date {
  const now = new Date();
  return new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** Returns the upcoming Wednesday given a "today" Date (in Colombia time). */
function nextWednesday(now: Date): Date {
  const d = new Date(now.getTime());
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysToAdd = (3 - dow + 7) % 7 || 7; // strictly next Wed (never "today")
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d;
}

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

export async function weeklyWedReminderCron(env: Env): Promise<void> {
  const s = await loadSession(env);
  if (!s) {
    console.log("[weeklyWedReminder] no session — skip");
    return;
  }

  const target = nextWednesday(nowInColombia());
  const dashed = dateToDdMmYyyyDashed(target);
  const friendly = dateToFriendly(target);
  console.log(`[weeklyWedReminder] target=${dashed} (${friendly})`);

  // Fetch the agenda for next Wednesday
  let bookings: AgendaBookingDoc[] = [];
  try {
    const b = new Bukeala(env);
    const res = await b.getAgenda(dashed, AREA_ID, /* includeCanceled */ false);
    const json = await res.json<any>().catch(() => null);
    bookings = (json?.areas?.[0]?.bookings ?? []) as AgendaBookingDoc[];
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.log("[weeklyWedReminder] session expired — skip");
      return;
    }
    console.log("[weeklyWedReminder] getAgenda failed:", (e as Error).message);
    return;
  }

  const active = bookings.filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime);
  console.log(`[weeklyWedReminder] ${active.length} active bookings to remind`);

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const bk of active) {
    const id = String(bk.id ?? "");
    const name = bk.name ?? "Paciente";
    const time = bk.startHourFormatted ?? "";
    const rawPhone = extractPhone(bk);
    if (!rawPhone) { skipped++; continue; }
    const phone = normalizeColombianPhone(rawPhone);
    if (!phone || phone.length < 10) { skipped++; continue; }

    const sentKey = `wed-reminder:sent:${id}`;
    if (await env.STATE.get(sentKey)) { skipped++; continue; }

    const consent = await env.STATE.get(`wa:consent:${phone}`);
    if (consent === "human") { skipped++; continue; }

    const r = await sendAppointmentReminder(
      env, phone, name, friendly, time, "Calle 80 # 10-43, Cons 506",
    );
    if (r.ok) {
      sent++;
      await env.STATE.put(sentKey, "1", { expirationTtl: 60 * 60 * 24 * 3 });
    } else {
      const err = (r as any).data?.error?.message ?? (r as any).reason ?? "unknown";
      errors.push(`${name} (${phone}): ${err}`);
    }
  }

  // Summary back to doctors so they can verify it ran
  const summary =
    `📲 <b>Recordatorios miércoles enviados</b> (${friendly})\n\n` +
    `Total citas: ${active.length}\n` +
    `✅ Enviados: ${sent}\n` +
    `⏭️ Saltados (sin tel, ya enviado o consent=human): ${skipped}\n` +
    (errors.length ? `❌ Errores: ${errors.length}\n${errors.slice(0, 5).map((e) => "• " + e).join("\n")}` : "");
  try {
    for (const chat of await getDoctorRecipients(env)) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: summary, parse_mode: "HTML" }),
      });
    }
  } catch (e) {
    console.log("[weeklyWedReminder] notify failed:", (e as Error).message);
  }
}
