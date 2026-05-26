/**
 * Quote follow-up cron — sends a friendly WhatsApp nudge 48-72h after Andrea
 * quoted a patient, if no booking has happened yet.
 *
 * Schedule: once per day at 9am Bogota (14:00 UTC) — see wrangler.toml.
 *
 * Logic:
 *   1. Read pending quote tickets from KV `quote:pending:list`
 *   2. For each ticket where:
 *        - status === "quoted"
 *        - quotedAt is between 48h and 72h ago
 *        - no follow-up sent yet (KV `quote:followup:sent:<ticketId>`)
 *        - patient hasn't requested human (`wa:consent:<phone>` !== "human")
 *      send a friendly WhatsApp message inviting them to continue.
 *   3. Cap at MAX_PER_RUN to avoid spam if backlog blows up.
 *   4. On success, mark KV `quote:followup:sent:<ticketId>` = "1" (30d TTL).
 *   5. Notify the doctor with a Telegram summary if anything was sent.
 */
import type { Env } from "../env";
import { sendText } from "../whatsapp";
import { getAllRecipients } from "../users";

const PENDING_KEY = "quote:pending:list";
const MAX_PER_RUN = 10;
const MS_48H = 48 * 3600 * 1000;
const MS_72H = 72 * 3600 * 1000;
const FOLLOWUP_TTL = 60 * 60 * 24 * 30; // 30 days

interface QuoteTicket {
  id: string;
  fromPhone: string;
  patientName: string;
  cedula?: string;
  source: "wa_ai" | "wa_doctor" | "manual";
  procedure?: string;
  details?: string;
  patientMessage?: string;
  context?: string;
  createdAt: number;
  status: "pending" | "quoted" | "accepted" | "rejected" | "expired";
  quotedBy?: string;
  quotedAmount?: string;
  quotedAt?: number;
}

function firstNameOf(patientName: string): string {
  // Bukeala stores names as "APELLIDO, NOMBRE" — split on comma or space.
  const parts = patientName.split(/[, ]/).filter(Boolean);
  // If we split on a comma, the first part is the surname → take the next chunk.
  // Otherwise (plain "Juan Pérez") the first chunk is already the first name.
  if (patientName.includes(",")) {
    return parts[1] ?? "";
  }
  return parts[0] ?? "";
}

export async function quoteFollowup(env: Env): Promise<void> {
  const raw = await env.STATE.get(PENDING_KEY);
  if (!raw) {
    console.log("[quoteFollowup] no pending list, skip");
    return;
  }

  let tickets: QuoteTicket[];
  try {
    const parsed = JSON.parse(raw);
    tickets = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.log("[quoteFollowup] failed to parse pending list:", (e as Error).message);
    return;
  }

  console.log(`[quoteFollowup] scanning ${tickets.length} tickets`);

  const now = Date.now();
  let sentCount = 0;
  const sentDetails: string[] = [];
  const errors: string[] = [];

  for (const t of tickets) {
    if (sentCount >= MAX_PER_RUN) break;

    if (t.status !== "quoted") continue;
    if (typeof t.quotedAt !== "number") continue;

    const age = now - t.quotedAt;
    if (age < MS_48H || age > MS_72H) continue;

    if (!t.fromPhone) continue;

    // Already followed up?
    const sentKey = `quote:followup:sent:${t.id}`;
    const already = await env.STATE.get(sentKey);
    if (already) continue;

    // Respect human handoff
    const consent = await env.STATE.get(`wa:consent:${t.fromPhone}`);
    if (consent === "human") continue;

    const firstName = firstNameOf(t.patientName);
    const greeting = firstName ? `Hola ${firstName}` : "Hola";
    const message =
      `${greeting}, soy del equipo del Dr. Duque. ¿Tuviste oportunidad de revisar la ` +
      `cotización que te enviamos? Cualquier duda o si quieres avanzar con la valoración, ` +
      `te ayudo aquí mismo.`;

    try {
      const r = await sendText(env, t.fromPhone, message);
      if (r.ok) {
        await env.STATE.put(sentKey, "1", { expirationTtl: FOLLOWUP_TTL });
        sentCount++;
        sentDetails.push(`${t.patientName} (${t.fromPhone})`);
      } else {
        const errMsg = r.data?.error?.message ?? `status ${r.status}`;
        errors.push(`${t.patientName} (${t.fromPhone}): ${errMsg}`);
        console.log(`[quoteFollowup] sendText failed for ${t.id}: ${errMsg}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${t.patientName} (${t.fromPhone}): ${msg}`);
      console.log(`[quoteFollowup] exception for ${t.id}: ${msg}`);
    }
  }

  console.log(`[quoteFollowup] sent=${sentCount} errors=${errors.length}`);

  // Skip notification if nothing happened
  if (sentCount === 0 && errors.length === 0) return;

  let summary = `📲 <b>Seguimientos cotización enviados</b>: ${sentCount}`;
  if (sentCount > 0) {
    summary += `\n\n` + sentDetails.slice(0, 10).map((d) => "• " + d).join("\n");
  }
  if (errors.length > 0) {
    summary += `\n\n❌ Errores: ${errors.length}\n` +
      errors.slice(0, 5).map((e) => "• " + e).join("\n");
  }

  const recipients = await getAllRecipients(env);
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
