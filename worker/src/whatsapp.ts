/**
 * WhatsApp Cloud API client (Meta Business).
 *
 * For PROACTIVE messages (sending to a patient who hasn't messaged us in
 * the last 24h), Meta requires a pre-approved Message Template. Until you
 * create + get approval for a custom template, we use the built-in
 * "hello_world" template that ships with every new WhatsApp Business
 * number — useful for testing the integration end-to-end.
 *
 * Once your template "appointment_reminder" is approved, swap to
 * sendAppointmentReminder() which uses parameters.
 */
import type { Env } from "./env";

const API_VERSION = "v21.0";

function apiUrl(env: Env): string {
  return `https://graph.facebook.com/${API_VERSION}/${env.WA_PHONE_ID}/messages`;
}

/** Normalize a Colombian phone number to E.164 format without `+` (Meta's format). */
export function normalizeColombianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("57") && digits.length >= 12) return digits;
  if (digits.length === 10) return "57" + digits;
  return digits; // best effort
}

async function postWA(env: Env, body: object): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(apiUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.WA_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[whatsapp] POST → ${res.status}`, JSON.stringify(data).slice(0, 400));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Send the built-in "hello_world" template. Useful for first integration test.
 * @param to phone number in E.164 without `+` (e.g. "573001234567")
 */
export async function sendHelloWorld(env: Env, to: string) {
  return postWA(env, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "hello_world",
      language: { code: "en_US" },
    },
  });
}

/**
 * Send a free-form text message. ONLY works within the 24h "customer
 * service window" — i.e. after the patient has messaged us. For proactive
 * messages outside that window use sendTemplate().
 */
export async function sendText(env: Env, to: string, body: string) {
  return postWA(env, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url: false },
  });
}

/**
 * Send a WhatsApp interactive message with buttons (max 3).
 * Use for consent prompt, slot selection, confirmations, etc.
 *
 * Each button: { id, title } where id ≤ 256 chars and title ≤ 20 chars.
 */
export async function sendInteractiveButtons(
  env: Env,
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  headerText?: string,
  footerText?: string,
) {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new Error("WhatsApp interactive buttons must be 1-3");
  }
  return postWA(env, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      ...(headerText ? { header: { type: "text", text: headerText } } : {}),
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: {
            id: b.id.slice(0, 256),
            title: b.title.slice(0, 20),
          },
        })),
      },
    },
  });
}

/**
 * Send a WhatsApp interactive list message (up to 10 rows per section, 10 sections).
 * Better than buttons when there are many options (e.g. available time slots).
 */
export async function sendInteractiveList(
  env: Env,
  to: string,
  bodyText: string,
  buttonText: string, // shown on the "open list" button (e.g. "Ver opciones")
  sections: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
  headerText?: string,
  footerText?: string,
) {
  return postWA(env, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      ...(headerText ? { header: { type: "text", text: headerText } } : {}),
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map((s) => ({
          ...(s.title ? { title: s.title.slice(0, 24) } : {}),
          rows: s.rows.map((r) => ({
            id: r.id.slice(0, 200),
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        })),
      },
    },
  });
}

/**
 * Send a custom template with parameters. Template must be pre-approved by Meta.
 * Example template "appointment_confirmation" with body params {patient_name}, {date}, {time}, {place}:
 *   sendTemplate(env, to, "appointment_confirmation", "es_CO", [{type:"text",text:"Juan"},...])
 */
export async function sendTemplate(
  env: Env,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: Array<{ type: "text"; text: string }>,
) {
  const components = bodyParams.length > 0
    ? [{ type: "body", parameters: bodyParams }]
    : undefined;
  return postWA(env, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  });
}

/**
 * Send the appointment confirmation template to the patient right after
 * a successful booking. Falls back gracefully if the template doesn't exist
 * yet (returns ok=false but doesn't throw).
 *
 * Template `appointment_confirmation` (es_CO) expected body:
 *   "Hola {{1}}, tu cita con el Dr. Duque está confirmada:
 *    📅 {{2}}
 *    ⏰ {{3}}
 *    🏥 {{4}}
 *    Para cancelar responde CANCELAR."
 */
export async function sendAppointmentConfirmation(
  env: Env,
  patientPhoneRaw: string,
  patientName: string,
  dateText: string,    // "Miércoles 06/05/26"
  timeText: string,    // "12:40 PM"
  place: string,       // "calle 80 # 10 43 cons 506"
) {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    console.log("[whatsapp] confirmation skipped: invalid phone", patientPhoneRaw);
    return { ok: false, reason: "invalid_phone" };
  }
  return sendTemplate(env, to, "appointment_confirmation_v2", "es_CO", [
    { type: "text", text: patientName },
    { type: "text", text: dateText },
    { type: "text", text: timeText },
    { type: "text", text: place },
  ]);
}
