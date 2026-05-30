/**
 * Evening reminder cron — segundo recordatorio del día, en la TARDE del día
 * previo a la cita. Complementa al reminderCron (que corre 8am).
 *
 * El doctor quiere DOS toques al paciente el día antes:
 *   - reminderCron        → 8am Bogotá (mañana)
 *   - eveningReminderCron → 6pm Bogotá (tarde)  ← este archivo
 *
 * Schedule: "0 23 * * *"  (23:00 UTC = 6 PM Colombia, todos los días)
 *
 * Reemplaza al weeklyWedReminderCron (que solo cubría miércoles): un evening
 * diario cubre todos los días, así que el de martes quedó redundante.
 *
 * Throttle: KV `evening-reminder:sent:{reservationCode}` con TTL 2 días.
 * Es un prefijo DISTINTO al de reminderCron (`reminder:sent:`) a propósito,
 * para que un paciente reciba ambos toques (mañana + tarde) sin que el
 * throttle de uno bloquee al otro.
 *
 * Consent: pacientes con `wa:consent:{phone} == "human"` se saltan.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { sendAppointmentConfirmRequest, normalizeColombianPhone } from "../whatsapp";
import { getAllRecipients } from "../users";
import type { AgendaBookingDoc } from "../agendaDoc";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MINUTES = -5 * 60;
const PLACE = "Calle 80 # 10-43, Cons 506";

function tomorrowInBogota(): Date {
  const now = new Date();
  const bogota = new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
  bogota.setUTCDate(bogota.getUTCDate() + 1);
  return bogota;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** Bukeala /admin/daily expects DD-MM-YYYY (dashes). */
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

export async function eveningReminderCron(env: Env): Promise<void> {
  const s = await loadSession(env);
  if (!s) {
    console.log("[eveningReminder] no session — skip");
    return;
  }
  const b = new Bukeala(env);
  const tomorrow = tomorrowInBogota();
  const dashed = dateToDdMmYyyyDashed(tomorrow);
  const friendly = dateToFriendly(tomorrow);
  console.log(`[eveningReminder] fetching agenda for ${dashed}`);

  let bookings: AgendaBookingDoc[] = [];
  try {
    const res = await b.getAgenda(dashed, AREA_ID, /* includeCanceled */ false);
    const j = await res.json<any>().catch(() => null);
    bookings = (j?.areas?.[0]?.bookings ?? []) as AgendaBookingDoc[];
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.log("[eveningReminder] session expired — skip");
      return;
    }
    console.log("[eveningReminder] fetch failed:", (e as Error).message);
    return;
  }

  const active = bookings.filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime);
  console.log(`[eveningReminder] found ${active.length} active bookings for ${dashed}`);

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

    // Throttle propio (distinto al de la mañana, para permitir doble toque)
    const sentKey = `evening-reminder:sent:${reservationCode}`;
    const already = await env.STATE.get(sentKey);
    if (already) { skippedCount++; continue; }

    // Si YA confirmó en la mañana (tocó el botón ✅), no lo molestamos de tarde
    const alreadyConfirmed = await env.STATE.get(`wa:citaConfirm:${reservationCode}`);
    if (alreadyConfirmed === "si") { skippedCount++; continue; }

    // Respeta consent: si pidió humano, no auto-recordatorio
    const consent = await env.STATE.get(`wa:consent:${phone}`);
    if (consent === "human") { skippedCount++; continue; }

    const r = await sendAppointmentConfirmRequest(env, phone, name, friendly, time12h, PLACE);
    if (r.ok) {
      sentCount++;
      await env.STATE.put(sentKey, "1", { expirationTtl: 60 * 60 * 24 * 2 });
      await env.STATE.put(
        `wa:pendingConfirm:${phone}`,
        JSON.stringify({ reservationCode, name, dateFriendly: friendly, time: time12h }),
        { expirationTtl: 60 * 60 * 24 * 2 },
      );
    } else {
      const err = (r as any).data?.error?.message ?? (r as any).reason ?? "unknown";
      errors.push(`${name} (${phone}): ${err}`);
    }
  }

  // Resumen a los usuarios autorizados
  const recipients = await getAllRecipients(env);
  const summary =
    `🌆 <b>Recordatorios de la TARDE enviados</b> para ${friendly}\n\n` +
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
