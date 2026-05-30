/**
 * Daily 1 PM Colombia cron — sends tomorrow's agenda as an HTML document
 * to the secretary, via BOTH Telegram (as a document) AND WhatsApp
 * (uploaded via the Cloud API media endpoint, then sent as type=document).
 *
 * Schedule: "0 18 * * *"  (18:00 UTC = 1 PM Colombia, every day)
 *
 * Recipients:
 *   - Telegram: every user with role "secretary" (per users.ts).
 *   - WhatsApp: numbers from env.SECRETARY_WHATSAPP_NUMBERS (comma-separated)
 *               or a hard-coded fallback (572 ... see DEFAULT_WA).
 *
 * Caveats:
 *   - WhatsApp free-form document send only works within the 24h customer
 *     service window. If the secretary hasn't messaged the WA business
 *     number in the last 24h, the send will fail (error 131047). The
 *     Telegram delivery still succeeds and we notify the doctor about
 *     the WA failure so it doesn't go silent.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { listUsers, getDoctorRecipients } from "../users";
import { buildAgendaHtml, type AgendaBookingDoc } from "../agendaDoc";
import { uploadMedia, sendDocumentByMediaId } from "../whatsapp";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MINUTES = -5 * 60;
const DEFAULT_WA = ["573232479260"];

function nowInColombia(): Date {
  const now = new Date();
  return new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

function tomorrowInColombia(): Date {
  const d = nowInColombia();
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function dateToDdMmYyyyDashed(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function dateToFriendly(d: Date): string {
  const day = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"][d.getUTCDay()];
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${day} ${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${yy}`;
}

function secretaryWaNumbers(env: Env): string[] {
  const raw = env.SECRETARY_WHATSAPP_NUMBERS?.trim();
  if (!raw) return DEFAULT_WA;
  return raw.split(",").map((n) => n.replace(/\D/g, "")).filter((n) => n.length >= 10);
}

async function sendTelegramDocument(
  env: Env,
  chatId: string,
  bytes: Uint8Array,
  filename: string,
  caption: string,
): Promise<{ ok: boolean; error?: string }> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([bytes], { type: "text/html" }), filename);
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form },
  );
  if (res.ok) return { ok: true };
  const t = await res.text().catch(() => "");
  return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 200)}` };
}

async function notifyDoctors(env: Env, text: string): Promise<void> {
  try {
    const doctors = await getDoctorRecipients(env);
    for (const chat of doctors) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
      });
    }
  } catch (e) {
    console.log("[secretaryAgenda] notifyDoctors failed:", (e as Error).message);
  }
}

export async function secretaryAgendaCron(env: Env): Promise<void> {
  const s = await loadSession(env);
  if (!s) {
    console.log("[secretaryAgenda] no session — skip");
    return;
  }

  const tomorrow = tomorrowInColombia();
  const dashed = dateToDdMmYyyyDashed(tomorrow);
  const friendly = dateToFriendly(tomorrow);
  console.log(`[secretaryAgenda] fetching agenda for ${dashed}`);

  // 1. Fetch the agenda
  let bookings: AgendaBookingDoc[] = [];
  try {
    const b = new Bukeala(env);
    const res = await b.getAgenda(dashed, AREA_ID, /* includeCanceled */ false);
    const json = await res.json<any>().catch(() => null);
    bookings = (json?.areas?.[0]?.bookings ?? []) as AgendaBookingDoc[];
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.log("[secretaryAgenda] session expired — skip (keepAlive will notify)");
      return;
    }
    console.log("[secretaryAgenda] getAgenda failed:", (e as Error).message);
    return;
  }

  const active = bookings.filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime);
  console.log(`[secretaryAgenda] ${active.length} active bookings for ${friendly}`);

  // 1b. Cargar el estado de confirmación por WhatsApp de cada cita
  //     (el paciente toca ✅/❌ en el botón del recordatorio → wa:citaConfirm:{id})
  const confirmMap: Record<string, "si" | "no"> = {};
  let confirmedCount = 0;
  for (const bk of active) {
    const id = String(bk.id ?? "");
    if (!id) continue;
    const v = await env.STATE.get(`wa:citaConfirm:${id}`);
    if (v === "si" || v === "no") {
      confirmMap[id] = v;
      if (v === "si") confirmedCount++;
    }
  }

  // 2. Build the HTML document
  const html = buildAgendaHtml(bookings, friendly, confirmMap);
  const bytes = new TextEncoder().encode(html);
  const filename = `Agenda_${dashed}.html`;
  const pending = active.length - confirmedCount;
  const caption =
    `📅 Agenda de mañana · ${friendly}\n` +
    `${active.length} ${active.length === 1 ? "cita" : "citas"} · ✅ ${confirmedCount} ya confirmaron por WhatsApp\n\n` +
    `📞 Falta llamar a ${pending}. Abre el archivo: los "☐ llamar" son los que hay que confirmar (toca el teléfono para llamar directo).`;

  // 3. Telegram — send to every secretary
  const users = await listUsers(env);
  const secretaries = users.filter((u) => u.role === "secretary");
  const tgErrors: string[] = [];
  let tgSent = 0;
  for (const u of secretaries) {
    const r = await sendTelegramDocument(env, u.chatId, bytes, filename, caption);
    if (r.ok) tgSent++;
    else tgErrors.push(`${u.name}: ${r.error}`);
  }
  console.log(`[secretaryAgenda] telegram → sent=${tgSent} errors=${tgErrors.length}`);

  // 4. WhatsApp — upload media once, then send to each secretary number
  const waErrors: string[] = [];
  let waSent = 0;
  const upload = await uploadMedia(env, bytes, "text/html", filename);
  if (!upload.ok || !upload.id) {
    waErrors.push(`upload: ${upload.error ?? "unknown"}`);
  } else {
    for (const to of secretaryWaNumbers(env)) {
      const r = await sendDocumentByMediaId(env, to, upload.id, filename, caption);
      if (r.ok) waSent++;
      else {
        const msg = (r.data as any)?.error?.message ?? `HTTP ${r.status}`;
        waErrors.push(`${to}: ${msg}`);
      }
    }
  }
  console.log(`[secretaryAgenda] whatsapp → sent=${waSent} errors=${waErrors.length}`);

  // 5. Summary to doctors so failures don't go silent
  const summary =
    `🗂️ <b>Agenda secretaría enviada</b> (${friendly})\n\n` +
    `${active.length} citas\n` +
    `📨 Telegram: ${tgSent}/${secretaries.length}` +
    (tgErrors.length ? `\n  • ${tgErrors.slice(0, 3).join("\n  • ")}` : "") +
    `\n📱 WhatsApp: ${waSent}/${secretaryWaNumbers(env).length}` +
    (waErrors.length ? `\n  • ${waErrors.slice(0, 3).join("\n  • ")}` : "");
  await notifyDoctors(env, summary);
}
