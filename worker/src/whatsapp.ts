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

/**
 * Result of a WhatsApp send helper. On a successful (or failed) API call it
 * carries `status` + `data` from Meta; on a pre-flight bail-out (e.g. invalid
 * phone) it carries `reason` instead. All optional so callers can read either
 * `data` or `reason` without narrowing.
 */
export type WaSendResult = {
  ok: boolean;
  status?: number;
  data?: any;
  reason?: string;
};

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
 *   sendTemplate(env, to, "appointment_confirmation", "es", [{type:"text",text:"Juan"},...])
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
): Promise<WaSendResult> {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    console.log("[whatsapp] confirmation skipped: invalid phone", patientPhoneRaw);
    return { ok: false, reason: "invalid_phone" };
  }
  return sendTemplate(env, to, "appointment_confirmation_v2", "es", [
    { type: "text", text: patientName },
    { type: "text", text: dateText },
    { type: "text", text: timeText },
    { type: "text", text: place },
  ]);
}

/**
 * Send a reminder ~24h before the appointment.
 * Template: appointment_reminder (es_CO)
 * Body params: {{1}} name, {{2}} date, {{3}} time, {{4}} place
 */
export async function sendAppointmentReminder(
  env: Env,
  patientPhoneRaw: string,
  patientName: string,
  dateText: string,
  timeText: string,
  place: string,
): Promise<WaSendResult> {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    console.log("[whatsapp] reminder skipped: invalid phone", patientPhoneRaw);
    return { ok: false, reason: "invalid_phone" };
  }
  return sendTemplate(env, to, "appointment_reminder", "es", [
    { type: "text", text: patientName },
    { type: "text", text: dateText },
    { type: "text", text: timeText },
    { type: "text", text: place },
  ]);
}

/**
 * Pide al paciente que CONFIRME su cita con botones (Quick Reply).
 *
 * Usa el template `confirmar_cita` (es_CO) que debe crearse en Meta Business
 * Manager con 2 botones de respuesta rápida:
 *    "✅ Sí, confirmo"   y   "❌ No podré"
 * Body params: {{1}} name, {{2}} date, {{3}} time, {{4}} place
 *
 * FALLBACK: si el template todavía no está aprobado (o falla), cae al
 * `appointment_reminder` normal para que el paciente igual reciba el aviso.
 * El campo `mode` indica qué se envió: "confirm" | "reminder_fallback".
 */
export async function sendAppointmentConfirmRequest(
  env: Env,
  patientPhoneRaw: string,
  patientName: string,
  dateText: string,
  timeText: string,
  place: string,
) {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    return { ok: false as const, reason: "invalid_phone", mode: "none" };
  }
  const params: Array<{ type: "text"; text: string }> = [
    { type: "text", text: patientName },
    { type: "text", text: dateText },
    { type: "text", text: timeText },
    { type: "text", text: place },
  ];
  const r = await sendTemplate(env, to, "confirmar_cita", "es", params);
  if (r.ok) return { ...r, mode: "confirm" };
  // Template aún no aprobado → recordatorio normal como respaldo
  const fb = await sendTemplate(env, to, "appointment_reminder", "es", params);
  return { ...fb, mode: "reminder_fallback" };
}

/**
 * Notify patient when their appointment was canceled.
 * Template: appointment_canceled (es_CO)
 * Body params: {{1}} name, {{2}} date, {{3}} time
 */
export async function sendAppointmentCanceled(
  env: Env,
  patientPhoneRaw: string,
  patientName: string,
  dateText: string,
  timeText: string,
): Promise<WaSendResult> {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    console.log("[whatsapp] canceled-notice skipped: invalid phone", patientPhoneRaw);
    return { ok: false, reason: "invalid_phone" };
  }
  return sendTemplate(env, to, "appointment_canceled", "es", [
    { type: "text", text: patientName },
    { type: "text", text: dateText },
    { type: "text", text: timeText },
  ]);
}

/**
 * Follow-up message a few days after a consultation appointment.
 * Template: appointment_followup (es_CO)
 * Body params: {{1}} name
 */
export async function sendAppointmentFollowup(
  env: Env,
  patientPhoneRaw: string,
  patientName: string,
): Promise<WaSendResult> {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    return { ok: false, reason: "invalid_phone" };
  }
  return sendTemplate(env, to, "appointment_followup", "es", [
    { type: "text", text: patientName },
  ]);
}

/**
 * Upload a binary file to the WhatsApp Cloud API Media endpoint.
 * Returns the media_id you can then attach to a `document`/`image`/etc message.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 */
export async function uploadMedia(
  env: Env,
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const url = `https://graph.facebook.com/${API_VERSION}/${env.WA_PHONE_ID}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}) as any);
  console.log(`[whatsapp] uploadMedia → ${res.status}`, JSON.stringify(data).slice(0, 200));
  if (res.ok && (data as any)?.id) {
    return { ok: true, id: String((data as any).id) };
  }
  return { ok: false, error: (data as any)?.error?.message ?? `HTTP ${res.status}` };
}

/**
 * Send a document attachment by media_id (uploaded via uploadMedia()).
 * Free-form messages only work within the 24h customer service window —
 * if the recipient hasn't messaged us recently, this will return error
 * 131047 ("Message failed to send because more than 24 hours have passed").
 */
export async function sendDocumentByMediaId(
  env: Env,
  to: string,
  mediaId: string,
  filename: string,
  caption?: string,
) {
  return postWA(env, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      id: mediaId,
      filename,
      ...(caption ? { caption } : {}),
    },
  });
}

/**
 * Post-surgery check-in N days after the procedure.
 * Template: post_surgery_checkin (es_CO)
 * Body params: {{1}} name, {{2}} daysSinceSurgery
 */
export async function sendPostSurgeryCheckin(
  env: Env,
  patientPhoneRaw: string,
  patientName: string,
  daysSinceSurgery: number,
): Promise<WaSendResult> {
  const to = normalizeColombianPhone(patientPhoneRaw);
  if (!to || to.length < 10) {
    return { ok: false, reason: "invalid_phone" };
  }
  return sendTemplate(env, to, "post_surgery_checkin", "es", [
    { type: "text", text: patientName },
    { type: "text", text: String(daysSinceSurgery) },
  ]);
}
