/**
 * Telegram update handler — minimalist (fetch directly to Telegram Bot API).
 *
 * Booking flow (calibrated against real Bukeala /debug/* responses):
 *
 *   /buscar
 *     → bot pide cédula
 *     → user manda cédula
 *     → bot:
 *        • findCustomer/validate (probando idType "1" cédula, luego "8" TI)
 *        • selectCustomer (302 esperado — "selecciona" al paciente en sesión)
 *        • findAvailabilityPage → parsea nombre/sexo/idType del HTML
 *        • loadComponents → muestra inline keyboard
 *     → user tap especialidad
 *     → bot:
 *        • doSearch → parsea slots de schedulesDay1/2/3
 *        • muestra inline keyboard de slots
 *     → user tap slot
 *     → bot pide email del paciente
 *     → user manda email
 *     → bot pide celular
 *     → user manda celular
 *     → bot muestra resumen + botón confirmar
 *     → user confirma
 *     → bot: validateBookingDate → addPrebooking → postBooking
 */
import type { Env } from "./env";
import { Bukeala, SessionExpiredError } from "./bukeala";
import {
  loadSession,
  loadState,
  saveState,
  clearState,
  type ConversationState,
} from "./kv";
import {
  handleHoy,
  handleManana,
  handleSemana,
  nextWeekdayDateFromAbbrev,
} from "./commands/dateShortcuts";
import { showWeeklyStats } from "./commands/stats";
import { searchByName } from "./commands/searchByName";
import { startBloquear } from "./commands/bloquear";
import {
  buildAgendaDetailKeyboard,
  showAgendaBookingDetail,
} from "./commands/agendaDetail";
import {
  loadRecentPatients,
  addRecentPatient,
  findRecentPatient,
  letterToBukealaIdType,
} from "./recentPatients";
import {
  DOCTORS,
  getActiveDoctor,
  setActiveDoctor,
  buildDoctorSelectorKeyboard,
} from "./doctors";
import { sendHelloWorld, normalizeColombianPhone, sendAppointmentConfirmation, sendText as sendWaText } from "./whatsapp";
import { suggestReply, appendHistory, getMode, setMode, type WaMode } from "./claudeAi";
import { getNativeHostEvents, requestRefresh } from "./handlers/nativeHostEvent";
import { isAllowed, isDoctor, getRole, getUserName, listUsers, addUser, removeUser, type Role } from "./users";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

async function tg(env: Env, method: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export const sendMessage = (env: Env, chat_id: string, text: string, extra: object = {}) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });

const answerCallback = (env: Env, callback_query_id: string, text?: string) =>
  tg(env, "answerCallbackQuery", { callback_query_id, text: text ?? "" });

// ====================================================================
// Cancelation reasons — extraidos de la respuesta real de Bukeala
// (GET /booking/action/cancelationReasons). 19 motivos.
// ====================================================================
const CANCELATION_REASONS: Array<{ id: string; description: string }> = [
  { id: "3", description: "Ajuste de agendamiento" },
  { id: "11", description: "Mejor oportunidad" },
  { id: "16", description: "Reprogramación paciente" },
  { id: "4", description: "Motivos personales" },
  { id: "2", description: "Enfermedad" },
  { id: "10", description: "Enfermedad aguda del paciente" },
  { id: "6", description: "Cita mal asignada y/o programada" },
  { id: "9", description: "Documentos incompletos" },
  { id: "14", description: "Paciente sin acompañante" },
  { id: "15", description: "Preparación inadecuada" },
  { id: "12", description: "No disponibilidad de profesional" },
  { id: "19", description: "Profesional en vacaciones" },
  { id: "18", description: "Profesional retirado" },
  { id: "17", description: "Usuario inactivo" },
  { id: "5", description: "Bloqueo administrador" },
  { id: "8", description: "Contingencia unidad" },
  { id: "7", description: "Daño de equipo" },
  { id: "13", description: "Paciente fallecido" },
  { id: "21", description: "Cancelado por reprogramación masiva" },
];

// ====================================================================
// Main handler
// ====================================================================
export async function handleUpdate(env: Env, update: any): Promise<void> {
  const message = update.message ?? update.edited_message;
  const callback = update.callback_query;

  const chatId = String(message?.chat?.id ?? callback?.message?.chat?.id ?? "");
  if (!chatId) return;

  if (!(await isAllowed(env, chatId))) {
    // Friendly onboarding message: tell them to share their ID with the doctor
    await sendMessage(
      env,
      chatId,
      `🚫 <b>Acceso denegado</b>\n\nNo estás autorizado(a) para usar este bot.\n\nSi necesitas acceso, pídele al Dr. David que te agregue. Comparte con él tu <b>chatId</b>:\n\n<code>${chatId}</code>\n\nÉl ejecutará en su Telegram:\n<code>/add_user ${chatId} secretary &lt;tu nombre&gt;</code>`,
    );
    return;
  }

  try {
    if (callback) return await onCallback(env, chatId, callback);
    if (message?.text) return await onText(env, chatId, message.text.trim());
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.log("SessionExpiredError thrown", { stack: (err as Error).stack });
      await sendMessage(
        env,
        chatId,
        "⚠️ Sesión expirada. Logueate en Bukeala desde tu PC y haz clic en la extensión para enviar una nueva sesión.",
      );
      await clearState(env, chatId);
      return;
    }
    console.error("handler error", err, (err as Error).stack);
    await sendMessage(env, chatId, "❌ Error: " + (err as Error).message);
  }
}

async function onText(env: Env, chatId: string, text: string): Promise<void> {
  if (text === "/start") {
    await clearState(env, chatId);
    const role = await getRole(env, chatId);
    const name = await getUserName(env, chatId);
    const isDoc = role === "doctor";
    const lines = [
      `<b>Bukeala bot</b> · Hola ${escapeHtmlLocal(name)} 👋`,
      "",
      "<b>📅 Agendar / consultar</b>",
      "/buscar — agendar nueva cita",
      "/citas — listar citas de un paciente",
      "/cancelar — cancelar una cita",
      "/buscar_nombre &lt;texto&gt; — buscar paciente por nombre",
      "",
      "<b>📋 Agenda</b>",
      "/hoy · /manana — agenda del día",
      "/agenda 13/05/2026 — fecha específica",
      "/agenda mie — próximo miércoles",
      "/semana — resumen 7 días",
      "/stats — estadísticas semanales",
      "/bloquear DD/MM/YYYY HH:MM HH:MM motivo",
      "",
      "<b>💬 WhatsApp pacientes</b>",
      "/wa_reply &lt;num&gt; &lt;mensaje&gt;",
      "/wa_mode &lt;num&gt; &lt;manual|review|auto&gt;",
      "/wa_status &lt;num&gt;",
      "",
      "<b>🔄 Sesión Bukeala</b>",
      "/sesion_renew — pedir nuevo login (cualquiera, abre ventana en PC)",
      "",
      "<b>👤 Cuenta</b>",
      "/whoami — quién soy",
      "/list_users — usuarios autorizados",
    ];
    if (isDoc) {
      lines.push(
        "",
        "<b>🔧 Admin (solo doctor)</b>",
        "/add_user &lt;chatId&gt; &lt;doctor|secretary&gt; &lt;nombre&gt;",
        "/remove_user &lt;chatId&gt;",
        "/doctor — cambiar doctor activo",
        "/sesion — estado sesión Bukeala",
        "/sesion_stats — estadísticas Native Host",
      );
    }
    lines.push("", "/cancelar_flujo — abortar conversación");
    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  if (text === "/cancelar_flujo") {
    await clearState(env, chatId);
    await sendMessage(env, chatId, "Listo, flujo cancelado. /start para empezar.");
    return;
  }

  if (text === "/sesion") {
    const s = await loadSession(env);
    if (!s) {
      await sendMessage(env, chatId, "🔴 Sin sesión. Captura una con la extensión.");
    } else {
      await sendMessage(
        env,
        chatId,
        `🟢 Sesión activa.\nCapturada: ${s.capturedAt}\nCookies: ${s.cookies.length}`,
      );
    }
    return;
  }

  if (text === "/buscar") {
    return startCedulaFlow(env, chatId, "buscar");
  }

  if (text === "/citas") {
    return startCedulaFlow(env, chatId, "citas");
  }

  if (text === "/cancelar") {
    return startCedulaFlow(env, chatId, "cancelar");
  }

  if (text === "/agenda" || text === "/hoy") {
    return handleHoy(env, chatId);
  }
  if (text === "/manana" || text === "/mañana") {
    return handleManana(env, chatId);
  }
  if (text === "/semana") {
    return handleSemana(env, chatId);
  }
  if (text.startsWith("/agenda ")) {
    const arg = text.slice("/agenda ".length).trim();
    // Try day-abbrev first (lun/mar/mie/...)
    const fromAbbrev = nextWeekdayDateFromAbbrev(arg);
    if (fromAbbrev) return showAgenda(env, chatId, fromAbbrev);
    const dateDashed = parseAgendaArgToDashed(arg);
    if (!dateDashed) {
      await sendMessage(env, chatId, "Fecha inválida. Usa <code>DD/MM/YYYY</code> o abreviatura de día (lun/mar/mie/...).");
      return;
    }
    return showAgenda(env, chatId, dateDashed);
  }

  if (text === "/stats") {
    return showWeeklyStats(env, chatId);
  }

  if (text.startsWith("/buscar_nombre ")) {
    const pattern = text.slice("/buscar_nombre ".length).trim();
    return searchByName(env, chatId, pattern);
  }
  if (text === "/buscar_nombre") {
    await sendMessage(env, chatId, "Uso: <code>/buscar_nombre &lt;texto&gt;</code> (mínimo 3 caracteres)");
    return;
  }

  if (text.startsWith("/bloquear ")) {
    const args = text.slice("/bloquear ".length).trim();
    return startBloquear(env, chatId, args);
  }
  if (text === "/bloquear") {
    return startBloquear(env, chatId, "");
  }

  if (text.startsWith("/wa_test ")) {
    const num = text.slice("/wa_test ".length).trim();
    const e164 = normalizeColombianPhone(num);
    if (!e164 || e164.length < 10) {
      await sendMessage(env, chatId, "Número inválido. Usa formato +573001234567 o 3001234567");
      return;
    }
    await sendMessage(env, chatId, `Enviando WhatsApp a ${e164}...`);
    const r = await sendHelloWorld(env, e164);
    if (r.ok) {
      const id = r.data?.messages?.[0]?.id;
      await sendMessage(env, chatId, `✅ Enviado. Message ID: <code>${id ?? "?"}</code>\nRevisa tu WhatsApp.`);
    } else {
      const err = r.data?.error?.message ?? JSON.stringify(r.data).slice(0, 300);
      await sendMessage(env, chatId, `❌ Error ${r.status}: ${err}`);
    }
    return;
  }

  // /wa_reply <number> <message>
  // Send a free-form text reply to a WhatsApp contact (only works inside the
  // 24h customer-service window, i.e. after the patient messaged us).
  if (text.startsWith("/wa_reply ")) {
    const rest = text.slice("/wa_reply ".length).trim();
    const sp = rest.indexOf(" ");
    if (sp < 0) {
      await sendMessage(env, chatId, "Uso: <code>/wa_reply &lt;número&gt; &lt;mensaje&gt;</code>");
      return;
    }
    const numRaw = rest.slice(0, sp).trim();
    const body = rest.slice(sp + 1).trim();
    const e164 = normalizeColombianPhone(numRaw);
    if (!e164 || e164.length < 10 || !body) {
      await sendMessage(env, chatId, "Número o mensaje inválido.");
      return;
    }
    const r = await sendWaText(env, e164, body);
    if (r.ok) {
      // Save to conversation history so Claude remembers it
      try { await appendHistory(env, e164, "assistant", body); } catch { /* ignore */ }
      const id = r.data?.messages?.[0]?.id;
      await sendMessage(env, chatId, `✅ Enviado a <code>${e164}</code>. Msg ID: <code>${id ?? "?"}</code>`);
    } else {
      const err = r.data?.error?.message ?? JSON.stringify(r.data).slice(0, 300);
      await sendMessage(env, chatId, `❌ Error ${r.status}: ${err}\n\n<i>Recordá: solo podés escribir libremente dentro de 24h después del último mensaje del paciente.</i>`);
    }
    return;
  }

  // ====================================================================
  // Multi-user / role commands
  // ====================================================================

  // /whoami — show your chatId, role, name
  if (text === "/whoami") {
    const role = await getRole(env, chatId);
    const name = await getUserName(env, chatId);
    await sendMessage(
      env,
      chatId,
      `<b>👤 Tu identidad</b>\n\nNombre: <b>${escapeHtmlLocal(name)}</b>\nRol: <b>${role ?? "—"}</b>\nChatId: <code>${chatId}</code>`,
    );
    return;
  }

  // /list_users — show all users (anyone authorized can see)
  if (text === "/list_users") {
    const users = await listUsers(env);
    const lines = users.map((u, i) => {
      const roleEmoji = u.role === "doctor" ? "👨‍⚕️" : "👩‍💼";
      return `${i + 1}. ${roleEmoji} <b>${escapeHtmlLocal(u.name)}</b> (${u.role})\n   <code>${u.chatId}</code>${u.addedBy ? ` — agregado por ${escapeHtmlLocal(u.addedBy)}` : ""}`;
    });
    await sendMessage(
      env,
      chatId,
      `<b>👥 Usuarios autorizados</b> (${users.length})\n\n${lines.join("\n\n")}`,
    );
    return;
  }

  // /add_user <chatId> <doctor|secretary> <nombre> — add a new user (doctors only)
  if (text.startsWith("/add_user ")) {
    if (!(await isDoctor(env, chatId))) {
      await sendMessage(env, chatId, "❌ Solo los doctores pueden agregar usuarios.");
      return;
    }
    const rest = text.slice("/add_user ".length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 3) {
      await sendMessage(
        env,
        chatId,
        "Uso: <code>/add_user &lt;chatId&gt; &lt;doctor|secretary&gt; &lt;nombre&gt;</code>\n\nEjemplo: <code>/add_user 987654321 secretary María Gómez</code>",
      );
      return;
    }
    const newChatId = parts[0];
    const role = parts[1] as Role;
    const name = parts.slice(2).join(" ");
    if (!["doctor", "secretary"].includes(role)) {
      await sendMessage(env, chatId, "Rol inválido. Usa <code>doctor</code> o <code>secretary</code>.");
      return;
    }
    const addedByName = await getUserName(env, chatId);
    const result = await addUser(env, newChatId, role, name, addedByName);
    if (result.ok) {
      await sendMessage(env, chatId, `✅ ${result.message}`);
      // Send a welcome to the new user
      try {
        await sendMessage(
          env,
          newChatId,
          `🎉 <b>¡Bienvenido(a) ${escapeHtmlLocal(name)}!</b>\n\nYa puedes usar el bot del Dr. Duque. Tu rol: <b>${role}</b>\n\nManda <code>/start</code> para ver los comandos disponibles.`,
        );
      } catch {
        // ignore — the user might not have started a chat with the bot yet
      }
    } else {
      await sendMessage(env, chatId, `❌ ${result.message}`);
    }
    return;
  }

  // /remove_user <chatId> — remove a user (doctors only)
  if (text.startsWith("/remove_user ")) {
    if (!(await isDoctor(env, chatId))) {
      await sendMessage(env, chatId, "❌ Solo los doctores pueden remover usuarios.");
      return;
    }
    const targetId = text.slice("/remove_user ".length).trim();
    const result = await removeUser(env, targetId);
    await sendMessage(env, chatId, result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
    return;
  }

  // /sesion_renew — request the local Native Host to open a fresh login window
  if (text === "/sesion_renew") {
    await requestRefresh(env, chatId);
    await sendMessage(
      env,
      chatId,
      "🔔 <b>Solicitud enviada</b>\n\nVe al PC del consultorio en los próximos 30 segundos.\nSe abrirá una ventana de Chromium con el login de Bukeala.\nLoguea con tus credenciales (incluido reCAPTCHA) y la ventana se cerrará sola.\n\n<i>Te aviso aquí cuando termine.</i>",
    );
    return;
  }

  // /sesion_stats — show Native Host event stats
  if (text === "/sesion_stats") {
    const events = await getNativeHostEvents(env);
    if (events.length === 0) {
      await sendMessage(env, chatId, "No hay eventos del Native Host aún. (¿Está corriendo la Scheduled Task?)");
      return;
    }
    const last24hCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const last7dCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const last24h = events.filter((e) => new Date(e.at).getTime() > last24hCutoff);
    const last7d = events.filter((e) => new Date(e.at).getTime() > last7dCutoff);
    const ok24 = last24h.filter((e) => e.type === "ok").length;
    const fail24 = last24h.filter((e) => e.type !== "ok").length;
    const ok7 = last7d.filter((e) => e.type === "ok").length;
    const fail7 = last7d.filter((e) => e.type !== "ok").length;
    const lastEvent = events[events.length - 1];
    const lastFails = events
      .filter((e) => e.type === "tgc_expired")
      .slice(-5)
      .map((e) => `• ${formatColombiaTime(e.at)}`)
      .join("\n");
    const lines = [
      "<b>📊 Estadísticas Native Host</b> <i>(hora Colombia)</i>",
      "",
      `<b>Última corrida:</b> ${formatColombiaTime(lastEvent.at)} — ${lastEvent.type === "ok" ? "✅ OK" : lastEvent.type === "tgc_expired" ? "⚠️ TGC expirado" : "❌ Error"}`,
      "",
      `<b>Últimas 24h:</b> ${ok24} OK, ${fail24} fallas`,
      `<b>Últimos 7 días:</b> ${ok7} OK, ${fail7} fallas`,
    ];
    if (lastFails) {
      lines.push("", "<b>Últimos TGC expirados:</b>", lastFails);
    }
    if (fail7 === 0) {
      lines.push("", "💚 ¡Sesión 100% estable los últimos 7 días!");
    }
    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  // /wa_mode <number> <manual|review|auto>
  // Switch how the bot handles inbound WhatsApp messages from a contact.
  if (text.startsWith("/wa_mode ")) {
    const rest = text.slice("/wa_mode ".length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(env, chatId, "Uso: <code>/wa_mode &lt;número&gt; &lt;manual|review|auto&gt;</code>\n\n• <b>manual</b>: solo te reenvío.\n• <b>review</b>: Claude propone y tú apruebas.\n• <b>auto</b>: Claude responde directo (con escalación).");
      return;
    }
    const e164 = normalizeColombianPhone(parts[0]);
    const newMode = parts[1] as WaMode;
    if (!["manual", "review", "auto"].includes(newMode)) {
      await sendMessage(env, chatId, "Modo inválido. Usa <code>manual</code>, <code>review</code> o <code>auto</code>.");
      return;
    }
    // auto-mode is admin-only (Claude responds without human review — sensitive)
    if (newMode === "auto" && !(await isDoctor(env, chatId))) {
      await sendMessage(env, chatId, "❌ Solo doctores pueden activar modo <code>auto</code>. Usa <code>review</code> en su lugar.");
      return;
    }
    await setMode(env, e164, newMode);
    await sendMessage(env, chatId, `✅ Modo de <code>${e164}</code> → <b>${newMode}</b>`);
    return;
  }

  // /wa_status <number>  →  show current mode + history length
  if (text.startsWith("/wa_status ")) {
    const numRaw = text.slice("/wa_status ".length).trim();
    const e164 = normalizeColombianPhone(numRaw);
    const mode = await getMode(env, e164);
    const histRaw = await env.STATE.get(`wa:history:${e164}`);
    let histLen = 0;
    try { histLen = histRaw ? JSON.parse(histRaw).length : 0; } catch { /* ignore */ }
    const draftRaw = await env.STATE.get(`wa:draft:${e164}`);
    await sendMessage(
      env,
      chatId,
      `<b>WhatsApp ${e164}</b>\nModo: <b>${mode}</b>\nHistorial: ${histLen} turnos\nBorrador pendiente: ${draftRaw ? "sí" : "no"}`,
    );
    return;
  }

  if (text === "/doctor") {
    const active = await getActiveDoctor(env);
    if (DOCTORS.length <= 1) {
      await sendMessage(env, chatId, `<b>Doctor activo:</b> ${active.name}\n\n(Solo hay un doctor configurado.)`);
      return;
    }
    await sendMessage(env, chatId, `<b>Doctor activo:</b> ${active.name}\n\nElige uno:`, {
      reply_markup: buildDoctorSelectorKeyboard(),
    });
    return;
  }

  // Stateful inputs
  const state = await loadState(env, chatId);
  if (state.step === "awaiting_customer_id") {
    return onCustomerIdEntered(env, chatId, text, state);
  }
  if (state.step === "awaiting_email") {
    return onEmailEntered(env, chatId, text, state);
  }
  if (state.step === "awaiting_phone") {
    return onPhoneEntered(env, chatId, text, state);
  }

  await sendMessage(env, chatId, "Comando no reconocido. /start para ayuda.");
}

async function onCallback(env: Env, chatId: string, callback: any): Promise<void> {
  const data: string = callback.data ?? "";
  await answerCallback(env, callback.id);

  if (data.startsWith("spec:")) {
    const [, code, idStr] = data.split(":");
    return onSpecialtySelected(env, chatId, code, Number(idStr));
  }
  if (data.startsWith("slot:")) {
    const idx = Number(data.slice(5));
    return onSlotSelected(env, chatId, idx);
  }
  if (data === "confirm:yes") {
    return onConfirm(env, chatId);
  }
  if (data === "confirm:no") {
    await clearState(env, chatId);
    await sendMessage(env, chatId, "Cancelado.");
    return;
  }
  if (data.startsWith("cancel:")) {
    // cancel:<reservationCode>
    const rc = data.slice("cancel:".length);
    return showCancelReasonsFor(env, chatId, rc);
  }
  if (data.startsWith("reason:")) {
    // reason:<reservationCode>:<reasonId>
    const [, rc, reasonId] = data.split(":");
    return doCancelBooking(env, chatId, rc, reasonId);
  }
  if (data.startsWith("nextdate:")) {
    // nextdate:<componentCode>:<DD/MM/YYYY>
    const rest = data.slice("nextdate:".length);
    const idx = rest.indexOf(":");
    const code = rest.slice(0, idx);
    const date = rest.slice(idx + 1);
    return runSearch(env, chatId, code, date);
  }
  if (data.startsWith("doctype:")) {
    const idType = data.slice("doctype:".length);
    return onDocTypeSelected(env, chatId, idType);
  }
  if (data.startsWith("agenda_detail:")) {
    const idx = Number(data.slice("agenda_detail:".length));
    return showAgendaBookingDetail(env, chatId, idx);
  }
  if (data.startsWith("recent:")) {
    const identification = data.slice("recent:".length);
    return onRecentPatientSelected(env, chatId, identification);
  }
  if (data.startsWith("doctor:")) {
    const id = data.slice("doctor:".length);
    try {
      await setActiveDoctor(env, id);
      const d = await getActiveDoctor(env);
      await sendMessage(env, chatId, `✅ Doctor activo: <b>${d.name}</b>`);
    } catch (e) {
      await sendMessage(env, chatId, `❌ Error: ${(e as Error).message}`);
    }
    return;
  }

  // ====================================================================
  // WhatsApp + Claude AI handoff buttons
  // ====================================================================
  if (data.startsWith("wa_suggest:")) {
    const phone = data.slice("wa_suggest:".length);
    return onWaSuggest(env, chatId, phone);
  }
  if (data.startsWith("wa_send:")) {
    const phone = data.slice("wa_send:".length);
    return onWaSendDraft(env, chatId, phone);
  }
  if (data.startsWith("wa_edit:")) {
    const phone = data.slice("wa_edit:".length);
    return onWaEdit(env, chatId, phone);
  }
  if (data.startsWith("wa_discard:")) {
    const phone = data.slice("wa_discard:".length);
    await env.STATE.delete(`wa:draft:${phone}`);
    await sendMessage(env, chatId, `🚫 Borrador descartado para <code>${phone}</code>.`);
    return;
  }
  if (data.startsWith("wa_auto:")) {
    if (!(await isDoctor(env, chatId))) {
      await sendMessage(env, chatId, "❌ Solo doctores pueden activar auto-modo.");
      return;
    }
    const phone = data.slice("wa_auto:".length);
    await setMode(env, phone, "auto");
    await sendMessage(env, chatId, `🟢 <b>Auto-modo ON</b> para <code>${phone}</code>. Claude responderá automáticamente. <code>/wa_mode ${phone} manual</code> para apagar.`);
    return;
  }
  if (data.startsWith("wa_off:")) {
    const phone = data.slice("wa_off:".length);
    await setMode(env, phone, "manual");
    await sendMessage(env, chatId, `🛑 <b>Auto-modo OFF</b> para <code>${phone}</code>.`);
    return;
  }
  if (data.startsWith("wa_takeover:")) {
    const phone = data.slice("wa_takeover:".length);
    await setMode(env, phone, "manual");
    await sendMessage(env, chatId, `✏️ Tomaste el control de <code>${phone}</code>. Usa <code>/wa_reply ${phone} ...</code> para responder.`);
    return;
  }
}

// ====================================================================
// WhatsApp + Claude handlers
// ====================================================================
async function onWaSuggest(env: Env, chatId: string, phone: string): Promise<void> {
  // Pull last user message from history
  const raw = await env.STATE.get(`wa:history:${phone}`);
  let lastUserMsg = "";
  try {
    const arr = raw ? JSON.parse(raw) : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === "user") { lastUserMsg = arr[i].content; break; }
    }
  } catch { /* ignore */ }
  if (!lastUserMsg) {
    await sendMessage(env, chatId, `No tengo mensaje reciente de <code>${phone}</code>.`);
    return;
  }
  const reply = await suggestReply(env, phone, lastUserMsg);
  if (reply.shouldEscalate) {
    await sendMessage(env, chatId, `⚠️ Claude escaló — no quiere responder este mensaje. Responde tú con /wa_reply.`);
    return;
  }
  await env.STATE.put(`wa:draft:${phone}`, reply.text, { expirationTtl: 60 * 60 * 24 });
  await sendMessage(
    env,
    chatId,
    `🤖 <b>Borrador de Claude:</b>\n\n<i>${escapeHtmlLocal(reply.text)}</i>`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Enviar", callback_data: `wa_send:${phone}` },
          { text: "✏️ Editar", callback_data: `wa_edit:${phone}` },
          { text: "🚫 Descartar", callback_data: `wa_discard:${phone}` },
        ]],
      },
    },
  );
}

async function onWaSendDraft(env: Env, chatId: string, phone: string): Promise<void> {
  const draft = await env.STATE.get(`wa:draft:${phone}`);
  if (!draft) {
    await sendMessage(env, chatId, `No hay borrador guardado para <code>${phone}</code>.`);
    return;
  }
  const r = await sendWaText(env, phone, draft);
  if (r.ok) {
    await appendHistory(env, phone, "assistant", draft);
    await env.STATE.delete(`wa:draft:${phone}`);
    await sendMessage(env, chatId, `✅ Enviado a <code>${phone}</code>.`);
  } else {
    const err = r.data?.error?.message ?? "unknown";
    await sendMessage(env, chatId, `❌ Error ${r.status}: ${err}`);
  }
}

async function onWaEdit(env: Env, chatId: string, phone: string): Promise<void> {
  const draft = await env.STATE.get(`wa:draft:${phone}`);
  await sendMessage(
    env,
    chatId,
    `Para editar y enviar, usa:\n<code>/wa_reply ${phone} ${draft ?? "<mensaje>"}</code>\n\nCopia el texto, modifícalo, y envía.`,
  );
}

function escapeHtmlLocal(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format a UTC ISO timestamp as Bogotá local time (UTC-5).
 * Uses Intl with timeZone: "America/Bogota" so DST changes (none in CO)
 * and any future tz updates are handled correctly.
 */
function formatColombiaTime(isoUtc: string): string {
  try {
    const d = new Date(isoUtc);
    const fmt = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    // Intl returns "DD/MM/YYYY, HH:MM" — flip to "YYYY-MM-DD HH:MM" for sortability
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    // Fallback: manual UTC-5 offset (Colombia has no DST)
    const d = new Date(isoUtc);
    d.setHours(d.getHours() - 5);
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

async function onRecentPatientSelected(
  env: Env,
  chatId: string,
  identification: string,
): Promise<void> {
  const rp = await findRecentPatient(env, identification);
  if (!rp) {
    await sendMessage(env, chatId, "Paciente no encontrado en cache. Usa el flujo manual.");
    return;
  }
  const state = await loadState(env, chatId);
  state.customer = {
    name: rp.name,
    identification: rp.identification,
    identificationType: rp.identificationType,
    gender: rp.gender,
    email: rp.email,
    phone: rp.phone,
  };
  state.selectedIdType = letterToBukealaIdType(rp.identificationType);
  state.step = "awaiting_customer_id";
  await saveState(env, chatId, state);
  // Reuse the existing onCustomerIdEntered handler — pass the cached identification
  await onCustomerIdEntered(env, chatId, rp.identification, state);
}

// ====================================================================
// Cedula entry — entry point for /buscar, /citas, /cancelar
// ====================================================================
const DOC_TYPES: Array<{ idType: string; short: string; label: string }> = [
  { idType: "1", short: "CC", label: "CC — Cédula de Ciudadanía" },
  { idType: "8", short: "TI", label: "TI — Tarjeta de Identidad" },
  { idType: "9", short: "RC", label: "RC — Registro Civil" },
  { idType: "2", short: "CE", label: "CE — Cédula de Extranjería" },
  { idType: "5", short: "PA", label: "PA — Pasaporte" },
];

async function startCedulaFlow(
  env: Env,
  chatId: string,
  mode: "buscar" | "citas" | "cancelar",
): Promise<void> {
  await clearState(env, chatId);
  await saveState(env, chatId, { step: "awaiting_doc_type", mode });
  const verb =
    mode === "buscar" ? "agendar" : mode === "citas" ? "consultar citas de" : "cancelar cita de";

  // Quick-pick: pacientes recientes
  const recents = await loadRecentPatients(env);
  const recentRows = recents.slice(0, 8).map((p) => [
    {
      text: `${p.name.slice(0, 28)} (${p.identificationType} ${p.identification})`,
      callback_data: `recent:${p.identification}`,
    },
  ]);
  const docRows = DOC_TYPES.map((t) => [
    { text: t.label, callback_data: `doctype:${t.idType}` },
  ]);
  const inline_keyboard =
    recentRows.length > 0 ? [...recentRows, ...docRows] : docRows;

  const header =
    recentRows.length > 0
      ? `<b>Paciente para ${verb}:</b>\n\nTap un paciente reciente, o elige tipo de documento abajo:`
      : `<b>Tipo de documento</b> del paciente para ${verb}:`;

  await sendMessage(env, chatId, header, { reply_markup: { inline_keyboard } });
}

async function onDocTypeSelected(env: Env, chatId: string, idType: string): Promise<void> {
  const state = await loadState(env, chatId);
  state.selectedIdType = idType;
  state.step = "awaiting_customer_id";
  await saveState(env, chatId, state);
  const docLabel = DOC_TYPES.find((t) => t.idType === idType)?.short ?? "documento";
  await sendMessage(
    env,
    chatId,
    `Mándame el número de <b>${docLabel}</b> del paciente (solo números):`,
  );
}

async function onCustomerIdEntered(
  env: Env,
  chatId: string,
  text: string,
  state: ConversationState,
): Promise<void> {
  const id = text.replace(/\D/g, "");
  if (!id || id.length < 5) {
    await sendMessage(env, chatId, "Cédula inválida. Escribe solo números.");
    return;
  }

  const b = new Bukeala(env);

  // Helper: try findCustomer with a warmup retry on session-expired.
  // Bukeala's session times out aggressively (~3-5 min idle). A warmup
  // call to the static find-customer page often re-establishes context.
  async function findCustomerWithRetry(t: string, id: string): Promise<any> {
    try {
      const res = await b.findCustomer(t, id);
      return await res.json<any>().catch(() => null);
    } catch (e) {
      if (!(e instanceof SessionExpiredError)) throw e;
      // Warmup retry: hit the find-customer page first
      console.log(`[bot] findCustomer ${t}/${id} expired — trying warmup`);
      try {
        const w = await b.findCustomerPage();
        await w.text();
      } catch {}
      const res = await b.findCustomer(t, id);
      return await res.json<any>().catch(() => null);
    }
  }

  // If the user already selected a doc type via the inline keyboard, use
  // ONLY that one. Otherwise fall back to autodetection (legacy path).
  const tryTypes = state.selectedIdType ? [state.selectedIdType] : ["1", "8", "9", "2", "5"];
  let found: { idType: string; raw: any } | null = null;
  for (const t of tryTypes) {
    const j = await findCustomerWithRetry(t, id);
    if (j?.result?.code === "EXISTS") {
      found = { idType: t, raw: j };
      break;
    }
  }

  if (!found) {
    await sendMessage(
      env,
      chatId,
      "No encontré ese paciente con ese documento (probé cédula y TI). Reintenta o /cancelar_flujo.",
    );
    return;
  }

  // Select customer in session (302 expected, redirects to /findAvailability).
  await b.selectCustomer(found.idType, id);

  // Fetch the findAvailability HTML to extract patient's name + gender.
  const pageRes = await b.findAvailabilityPage();
  const html = await pageRes.text();
  const patient = parsePatientFromFindAvailability(html);

  if (!patient) {
    await sendMessage(
      env,
      chatId,
      "❌ No pude leer los datos del paciente del HTML. Reportar al desarrollador.",
    );
    return;
  }

  // Save patient data into state.
  state.customer = {
    name: patient.name,
    identification: id,
    identificationType: patient.identificationType,
    gender: patient.gender,
  };
  await saveState(env, chatId, state);

  // Branch on mode: buscar shows components, citas/cancelar show bookings.
  const mode = state.mode ?? "buscar";
  if (mode === "citas" || mode === "cancelar") {
    return showPatientBookings(env, chatId, patient.name, mode === "cancelar");
  }

  // Mode "buscar": load available components.
  const cRes = await b.loadComponents();
  const cJson = await cRes.json<any>().catch(() => []);
  const components = parseComponents(cJson);

  if (components.length === 0) {
    await sendMessage(
      env,
      chatId,
      `Paciente: <b>${patient.name}</b>\n\n⚠️ No hay especialidades disponibles para este paciente.`,
    );
    await clearState(env, chatId);
    return;
  }

  state.step = "awaiting_specialty";
  await saveState(env, chatId, state);

  await sendMessage(
    env,
    chatId,
    `Paciente: <b>${patient.name}</b>\nSexo: ${patient.gender} | Doc: ${patient.identificationType}\n\nSelecciona la especialidad:`,
    {
      reply_markup: {
        inline_keyboard: components.map((c) => [
          { text: c.name, callback_data: `spec:${c.code}:${c.id}` },
        ]),
      },
    },
  );
}

async function showPatientBookings(
  env: Env,
  chatId: string,
  patientName: string,
  cancelMode: boolean,
): Promise<void> {
  const b = new Bukeala(env);
  const res = await b.myBookings(false);
  const html = await res.text();
  const bookings = parseBookingsFromMyBookings(html);
  console.log(`[bot] parseBookings: html=${html.length}b, found=${bookings.length} bookings`);
  if (bookings.length === 0 && html.length < 500) {
    console.log(`[bot] EMPTY HTML body: ${html}`);
  } else if (bookings.length === 0) {
    // Log a sample of the HTML to debug parsing
    const sample = html.slice(html.indexOf("booking-card") - 50, html.indexOf("booking-card") + 300);
    console.log(`[bot] HTML sample around 'booking-card': ${sample}`);
  }

  if (bookings.length === 0) {
    await sendMessage(env, chatId, `<b>${patientName}</b> no tiene citas pendientes.`);
    await clearState(env, chatId);
    return;
  }

  const lines: string[] = [`<b>Citas de ${patientName} (${bookings.length})</b>`, ""];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const bk of bookings) {
    lines.push(
      `• ${bk.weekday} <b>${bk.date}</b> ${bk.time} — ${bk.component}\n   ${bk.status}${bk.plan ? " · " + bk.plan : ""}`,
    );
    if (cancelMode && bk.status.toLowerCase().includes("pendiente")) {
      buttons.push([
        {
          text: `❌ Cancelar ${bk.date} ${bk.time}`,
          callback_data: `cancel:${bk.reservationCode}`,
        },
      ]);
    }
  }

  await sendMessage(env, chatId, lines.join("\n\n"), {
    reply_markup: cancelMode && buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  });
  await clearState(env, chatId);
}

type Component = { id: number; code: string; name: string };

function parseComponents(json: any): Component[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((x: any) => ({
      id: Number(x.id ?? 0),
      code: String(x.code ?? ""),
      name: String(x.description ?? x.name ?? "").trim(),
    }))
    .filter((c) => c.id && c.code && c.name);
}

async function onSpecialtySelected(
  env: Env,
  chatId: string,
  code: string,
  id: number,
): Promise<void> {
  const state = await loadState(env, chatId);
  state.componentCode = code;
  state.componentId = id;
  state.step = "awaiting_slot";
  await saveState(env, chatId, state);

  return runSearch(env, chatId, code, ddmmyyyy(new Date()));
}

/**
 * Run doSearch from a given start date and present results (or a
 * "search later" button if empty).
 */
async function runSearch(
  env: Env,
  chatId: string,
  code: string,
  startDateStr: string,
): Promise<void> {
  const b = new Bukeala(env);
  // CRITICAL: replicate the exact sequence the web UI performs before doSearch.
  // Without ALL these steps, doSearch returns "no disponibilidad" even when
  // slots exist. Captured from HAR of working browser session.
  try {
    await (await b.loadBranches("", [code])).text();
    await (await b.changeUserTypeSelected("309", "")).text();
    await (await b.getAvailablePlans()).text();
    await (await b.loadAreaHints(code)).text();
  } catch (e) {
    console.log("[bot] warmup error (ignored):", (e as Error).message);
  }
  // /do (HTML) sets the search context server-side
  const doRes = await b.findAvailabilityDoPage({
    componentCodes: [code],
    startDateStr,
  });
  await doRes.text(); // discard HTML

  const res = await b.doSearch({ startDateStr, componentCodes: [code] });
  const json = await res.json<any>().catch(() => null);
  // Year for converting "Miércoles 6 de Mayo" → "06/05/YY"
  const year = (() => {
    const m = startDateStr.match(/\/(\d{4})$/);
    return m ? Number(m[1]) : new Date().getFullYear();
  })();
  const slots = parseSlots(json, { componentCode: code, year }).slice(0, 24);
  console.log(`[bot] runSearch: schedulesDay1=${(json?.schedulesDay1 || []).length}, parsed=${slots.length}`);

  if (slots.length === 0) {
    const emptyMsg = stripHtmlTags(json?.emptyMessage ?? "No hay slots disponibles.");
    const next = json?.nextDayForSearchFormatted; // "DD/MM/YY"
    const dateRange = `${json?.dateFromFormatted ?? startDateStr} – ${json?.dateToFormatted ?? "?"}`;
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    if (next) {
      // Convert DD/MM/YY → DD/MM/YYYY for the next call
      const next4 = next.replace(/(\d{2})\/(\d{2})\/(\d{2})$/, (_m: string, d: string, mo: string, y: string) => `${d}/${mo}/20${y}`);
      buttons.push([
        { text: `→ Buscar desde ${next}`, callback_data: `nextdate:${code}:${next4}` },
      ]);
    }
    buttons.push([{ text: "❌ Salir", callback_data: "confirm:no" }]);
    await sendMessage(env, chatId, `<b>Sin slots</b> en ${dateRange}.\n\n${emptyMsg}`, {
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  // Persist slots in KV (separate key) so we can resolve "slot:<idx>" later.
  await env.STATE.put(`slots:${chatId}`, JSON.stringify(slots), {
    expirationTtl: 60 * 15,
  });

  await sendMessage(env, chatId, `Slots disponibles desde ${startDateStr}:`, {
    reply_markup: {
      inline_keyboard: slots.map((s, i) => [{ text: s.label, callback_data: `slot:${i}` }]),
    },
  });
}

type Slot = {
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

// Branch / area constants for this single-doctor bot. Pulled from the
// HAR captures of postBooking + loadBranches.
const BRANCH_CODE = "7960";
const AREA_CODE = "80040718";
const AREA_ID = 1074; // numeric area id for /agenda endpoint
// Working hours for the daily agenda grid (used to fill "free" slots).
const WORK_START_HOUR = 8;   // 8:00 AM
const WORK_END_HOUR = 13;    // 1:00 PM
const SLOT_MINUTES = 20;

const SPANISH_MONTHS: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

/** "Miércoles 6 de Mayo" + year=2026 → "06/05/26" */
function dayInLettersToDDMMYY(s: string, year: number): string {
  if (!s) return "";
  const m = s.match(/(\d+)\s+de\s+(\w+)/i);
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const month = SPANISH_MONTHS[m[2].toLowerCase()] ?? "01";
  const yy = String(year).slice(-2);
  return `${day}/${month}/${yy}`;
}

/**
 * Parse the doSearch response. Real slot shape (verified against live data):
 *   { calendarId, id, componentId, branchId, areaId, isPresential,
 *     timeInSeconds, durationInSeconds, dayInLetters, ... }
 * Day labels come as `day1Formatted="Miércoles 6 de Mayo"` (no year/no
 * DD/MM/YY format), so we convert using `dateFromFormatted` for year.
 */
function parseSlots(
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

  // Grouped form (some flows)
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

  return out.filter((s) => s.bookingComponentId && s.areaId && s.dateFormatted && s.timeInSeconds);
}

async function onSlotSelected(env: Env, chatId: string, idx: number): Promise<void> {
  const slotsRaw = await env.STATE.get(`slots:${chatId}`);
  if (!slotsRaw) {
    await sendMessage(env, chatId, "Slots expiraron. /buscar de nuevo.");
    return;
  }
  const slots = JSON.parse(slotsRaw) as Slot[];
  const slot = slots[idx];
  if (!slot) {
    await sendMessage(env, chatId, "Slot inválido.");
    return;
  }

  const state = await loadState(env, chatId);
  state.selectedSlot = { ...slot };
  await saveState(env, chatId, state);

  // Call /booking/assign to render the confirmation page; that HTML embeds
  // the patient's email + phone pre-populated from Bukeala's DB. Parse it.
  const cust = state.customer!;
  const componentCode = state.componentCode!;
  const componentName = ""; // not strictly needed for the searchParams payload

  const searchParamsJson = JSON.stringify({
    branchId: Number(env.BRANCH_ID),
    jsonComponentCodes: JSON.stringify([componentCode]),
    startDateStr: ddmmyyyy(new Date()),
    areaPattern: "",
    resultGrouped: false,
    resultShow: 0,
    followedBookingsCount: 1,
    isMultipleComponent: false,
    attentionType: "P",
    isOverBooking: "false",
    minQuantitySessions: 1,
    maxQuantitySessions: 1,
    branchName: "",
    jsonComponents: JSON.stringify([{ code: componentCode, description: componentName }]),
  });

  const bookingsDataJsonForAssign = JSON.stringify([
    {
      bookingComponentId: slot.bookingComponentId,
      areaId: slot.areaId,
      dateFormatted: slot.dateFormatted,
      timeInSeconds: slot.timeInSeconds,
      timeInBetween: "",
    },
  ]);

  const b = new Bukeala(env);
  const assignRes = await b.assignBooking({
    branchId: env.BRANCH_ID,
    customerIdentification: cust.identification,
    customerIdentificationType: cust.identificationType,
    customerGender: cust.gender,
    bookingsDataJson: bookingsDataJsonForAssign,
    multipleComponentId: "",
    searchParamsJson,
    isReassignBooking: "false",
    reassignOriginalBookingId: "",
    cancelationReasonId: "",
    cancelationComment: "",
    notificationPendingBooking: "",
    groupSelect: "false",
    followedBookingsCount: "",
    overBooking: "false",
    authorizationCode: "",
  });
  const assignHtml = await assignRes.text();
  const contact = parseContactFromAssign(assignHtml);
  state.customer!.email = contact.email;
  state.customer!.phone = contact.phone;
  await saveState(env, chatId, state);

  // If patient has no email registered, ask for one (Bukeala requires it).
  if (!contact.email) {
    state.step = "awaiting_email";
    await saveState(env, chatId, state);
    await sendMessage(
      env,
      chatId,
      `Slot: <b>${slot.label}</b>\nPaciente: <b>${cust.name}</b>\n\nEl paciente no tiene email registrado. Mándame el email para la cita:`,
    );
    return;
  }
  if (!contact.phone) {
    state.step = "awaiting_phone";
    await saveState(env, chatId, state);
    await sendMessage(
      env,
      chatId,
      `Email: ${contact.email}\n\nEl paciente no tiene celular registrado. Mándame el celular (10 dígitos):`,
    );
    return;
  }

  return showConfirmation(env, chatId, state);
}

async function showConfirmation(env: Env, chatId: string, state: ConversationState): Promise<void> {
  const slot = state.selectedSlot!;
  const cust = state.customer!;
  state.step = "confirming";
  await saveState(env, chatId, state);
  await sendMessage(
    env,
    chatId,
    [
      `<b>Confirmar cita</b>`,
      ``,
      `Paciente: <b>${cust.name}</b>`,
      `Cédula: ${cust.identification}`,
      `Sexo: ${cust.gender}`,
      `Email: ${cust.email || "(ninguno)"}`,
      `Celular: ${cust.phone || "(ninguno)"}`,
      ``,
      `Slot: <b>${slot.label}</b>`,
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirmar", callback_data: "confirm:yes" }],
          [{ text: "❌ Cancelar", callback_data: "confirm:no" }],
        ],
      },
    },
  );
}

async function onEmailEntered(
  env: Env,
  chatId: string,
  text: string,
  state: ConversationState,
): Promise<void> {
  const email = text.trim();
  if (!/.+@.+\..+/.test(email)) {
    await sendMessage(env, chatId, "Email inválido. Reintenta (debe tener formato `nombre@dominio.com`).");
    return;
  }
  state.customer = state.customer ?? ({} as any);
  state.customer!.email = email;
  await saveState(env, chatId, state);
  if (!state.customer!.phone) {
    state.step = "awaiting_phone";
    await saveState(env, chatId, state);
    await sendMessage(env, chatId, `Email: ${email}\n\nMándame el celular (10 dígitos, sin código país):`);
    return;
  }
  return showConfirmation(env, chatId, state);
}

async function onPhoneEntered(
  env: Env,
  chatId: string,
  text: string,
  state: ConversationState,
): Promise<void> {
  const phone = text.replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 12) {
    await sendMessage(env, chatId, "Celular inválido (necesita 7-12 dígitos). Reintenta.");
    return;
  }
  state.customer = state.customer ?? ({} as any);
  state.customer!.phone = phone;
  await saveState(env, chatId, state);
  return showConfirmation(env, chatId, state);
}

async function onConfirm(env: Env, chatId: string): Promise<void> {
  const state = await loadState(env, chatId);
  const slot = state.selectedSlot;
  const cust = state.customer;
  if (!slot || !cust) {
    await sendMessage(env, chatId, "Estado incompleto. /buscar de nuevo.");
    return;
  }

  const b = new Bukeala(env);

  // 1) validateBookingDate
  const v = await b.validateBookingDate({
    bookingComponentId: slot.bookingComponentId,
    startDateStr: slot.dateFormatted,
    bookingTime: slot.timeInSeconds,
    areaId: slot.areaId,
  });
  await v.text(); // discard

  // 2) addPrebookingSchedule
  await b.addPrebooking({
    bookingComponentId: slot.bookingComponentId,
    timeInSeconds: slot.timeInSeconds,
    startDateStr: slot.dateFormatted,
    areaId: slot.areaId,
  });

  // 3) postBooking
  const bookingsDataJson = JSON.stringify([
    {
      bookingComponentId: slot.bookingComponentId,
      bookingComponentCode: slot.bookingComponentCode,
      branchCode: slot.branchCode,
      unidadOrganizativa: slot.branchCode,
      preparationMessages: [],
      areaId: slot.areaId,
      areaCode: slot.areaCode,
      comment: "200",
      dateFormatted: slot.dateFormatted,
      timeInSeconds: slot.timeInSeconds,
      attachmentUrls: null,
      duration: slot.duration,
    },
  ]);

  const payload = {
    bookingsDataJson,
    branchId: env.BRANCH_ID,
    name: cust.name,
    customerIdentification: cust.identification,
    customerIdentificationType: cust.identificationType ?? "C",
    customerGender: cust.gender ?? "F",
    unidadOrganizativa: slot.branchCode,
    branchCode: slot.branchCode,
    email: cust.email ?? "",
    comment: "",
    phoneCountryCode: "mx", // bug del frontend pero el backend lo acepta así
    cellPhone: cust.phone
      ? { id: null, phoneNumber: cust.phone, countryCode: "co", dialCode: "+57" }
      : null,
    landPhone: null,
    overBooking: false,
    followedBookingsCount: 1,
    isReassign: false,
    cancelationComment: "",
    presential: "true",
    multipleComponentIdStr: "",
  };

  console.log(`[bot] postBooking payload: ${JSON.stringify(payload).slice(0, 800)}`);
  const res = await b.postBooking(payload);
  const rawText = await res.text();
  console.log(`[bot] postBooking response (status ${res.status}): ${rawText.slice(0, 800)}`);
  const json = (() => { try { return JSON.parse(rawText); } catch { return null; } })();

  await clearState(env, chatId);
  await env.STATE.delete(`slots:${chatId}`);

  if (json?.result?.code === "SUCCESS") {
    const r = json.bookingResults?.[0];
    const reservationCode = r?.reservationCode ?? "(?)";
    const dateStr = r?.bookingDateStr ?? slot.dateFormatted;
    const timeStr = r?.bookingTimeStr ?? secondsToHHMM(slot.timeInSeconds);
    const dayStr = r?.dayOfWeekInLetters ?? "";
    // Feature 8: persist patient as recent
    try {
      await addRecentPatient(env, {
        name: cust.name,
        identification: cust.identification,
        identificationType: cust.identificationType ?? "C",
        gender: cust.gender ?? "F",
        email: cust.email,
        phone: cust.phone,
      });
    } catch (e) {
      console.log("[bot] addRecentPatient failed:", (e as Error).message);
    }
    // Send WhatsApp confirmation to the patient (best-effort)
    let waStatus = "";
    if (cust.phone) {
      try {
        const wa = await sendAppointmentConfirmation(
          env,
          cust.phone,
          cust.name,
          `${dayStr} ${dateStr}`.trim(),
          timeStr,
          "calle 80 # 10 43 cons 506, Bogotá",
        );
        if (wa.ok) {
          waStatus = "📱 WhatsApp confirmación enviado al paciente.";
        } else {
          const errMsg =
            ("data" in wa && wa.data?.error?.message) ||
            ("reason" in wa && wa.reason) ||
            "desconocido";
          waStatus = `📱 WhatsApp no enviado: ${String(errMsg).slice(0, 80)}`;
        }
      } catch (e) {
        waStatus = `📱 WhatsApp falló: ${(e as Error).message.slice(0, 80)}`;
      }
    } else {
      waStatus = "📱 (Sin celular: no se envió WhatsApp)";
    }
    await sendMessage(
      env,
      chatId,
      [
        `✅ <b>Cita agendada</b>`,
        ``,
        `Paciente: ${cust.name}`,
        `${dayStr} ${dateStr} a las ${timeStr}`,
        `Código: <code>${reservationCode}</code>`,
        ``,
        waStatus,
      ].join("\n"),
    );
  } else {
    const msg = json?.messages?.[0]?.description ?? json?.result?.description ?? "Error desconocido";
    await sendMessage(env, chatId, `❌ Error agendando: ${stripHtmlTags(msg)}`);
  }
}

// ====================================================================
// Cancelation
// ====================================================================
async function showCancelReasonsFor(
  env: Env,
  chatId: string,
  reservationCode: string,
): Promise<void> {
  const buttons = CANCELATION_REASONS.map((r) => [
    { text: r.description, callback_data: `reason:${reservationCode}:${r.id}` },
  ]);
  await sendMessage(env, chatId, `Motivo de cancelación para <code>${reservationCode}</code>:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function doCancelBooking(
  env: Env,
  chatId: string,
  reservationCode: string,
  reasonId: string,
): Promise<void> {
  const b = new Bukeala(env);
  const res = await b.cancelBooking({
    reservationCode,
    cancelReasonId: reasonId,
    cancelationComment: "Cancelado vía bot",
  });
  const json = await res.json<any>().catch(() => null);
  if (json?.result?.code === "SUCCESS") {
    await sendMessage(env, chatId, `✅ Cita ${reservationCode} cancelada.`);
  } else {
    const msg = json?.result?.description ?? json?.messages?.[0]?.description ?? "Error desconocido";
    await sendMessage(env, chatId, `❌ No se pudo cancelar: ${stripHtmlTags(msg)}`);
  }
}

// ====================================================================
// HTML parsers
// ====================================================================
type Patient = { name: string; identification: string; identificationType: string; gender: string };

/**
 * Parse the /findAvailability HTML to extract patient name, ID type, gender.
 * Real DOM (verified):
 *   <span class="user-name">Cepeda Sanabria, Andrea Del Pilar</span>
 *   <span class="content">Cedula Ciudadania (C)</span>
 *   <span class="content">63438331</span>
 *   <span class="content">FEMENINO</span>
 */
function parsePatientFromFindAvailability(html: string): Patient | null {
  const nameMatch = html.match(/<span\s+class="user-name">([^<]+)<\/span>/);
  if (!nameMatch) return null;
  const name = decodeHtml(nameMatch[1].trim());

  // Walk the user-data block looking for the ID type, identification, and gender.
  // We look for "(X)" pattern in the doc-type label (e.g. "Cedula Ciudadania (C)").
  const idTypeMatch = html.match(/<span class="content">[^<]*\(([A-Z])\)<\/span>/);
  const identificationType = idTypeMatch ? idTypeMatch[1] : "C";

  const genderMatch = html.match(/<span class="content">(FEMENINO|MASCULINO)<\/span>/);
  const gender = genderMatch?.[1] === "MASCULINO" ? "M" : "F";

  // identification is also visible but we already have it from the user input; not parsed here.
  return { name, identificationType, gender, identification: "" };
}

type BookingCard = {
  reservationCode: string;
  status: string;
  weekday: string;
  date: string;
  time: string;
  component: string;
  plan: string;
};

/**
 * Parse the /myBookings HTML. Real DOM:
 *   <div class="booking-card-container" id="item869128-424200" data-booking-id="424200" ...>
 *     <div class="booking-card flex-h pending|canceled">
 *       <p class="status">Pendiente</p>
 *       <p class="weekday">Miércoles</p>
 *       <p class="date">06/05/26</p>
 *       <p class="time">12:40 PM</p>
 *       <p class="plan">Plan: Colsanitas Integral (10)</p>
 *       <p class="component">CIRUGIA PLASTICA Y RECONSTRUCTIVA PRESENCIAL</p>
 *       ...
 */
function parseBookingsFromMyBookings(html: string): BookingCard[] {
  const out: BookingCard[] = [];
  const containerRe = /<div class="booking-card-container"[^>]*id="item([\d-]+)"[^>]*>([\s\S]*?)(?=<div class="booking-card-container"|<\/main>|$)/g;

  let m: RegExpExecArray | null;
  while ((m = containerRe.exec(html))) {
    const reservationCode = m[1];
    const block = m[2];

    const status = textOf(block, /<p class="status">\s*([\s\S]*?)\s*<\/p>/);
    const weekday = textOf(block, /<p class="weekday">\s*([\s\S]*?)\s*<\/p>/);
    const date = textOf(block, /<p class="date">\s*([\s\S]*?)\s*<\/p>/);
    const time = textOf(block, /<p class="time">\s*([\s\S]*?)\s*<\/p>/);
    const plan = textOf(block, /<p class="plan">\s*([\s\S]*?)\s*<\/p>/);
    const component = textOf(block, /<p class="component">\s*([\s\S]*?)\s*<\/p>/);

    out.push({ reservationCode, status, weekday, date, time, plan, component });
  }
  return out;
}

function textOf(html: string, re: RegExp): string {
  const m = html.match(re);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}

/**
 * Parse contact info (email, phone) from /booking/assign HTML.
 * Bukeala pre-fills the form fields from the patient's record:
 *   <input id="customerEmail" value="paciente@ejemplo.com" ...>
 *   <input id="cellPhone" data-country-code="co" value="3001234567" ...>
 * The exact selectors depend on the page version; we try several.
 */
function parseContactFromAssign(html: string): { email: string; phone: string } {
  // Email
  let email = "";
  const emailPatterns = [
    /id="customerEmail"[^>]*value="([^"]+)"/,
    /id="email"[^>]*value="([^"]+)"/,
    /name="email"[^>]*value="([^"]+)"/,
    /data-customer-email="([^"]+)"/,
  ];
  for (const re of emailPatterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].includes("@")) {
      email = m[1];
      break;
    }
  }

  // Phone
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
      // Strip leading country code (57) if present and length > 10
      if (phone.length > 10 && phone.startsWith("57")) phone = phone.slice(2);
      if (phone.length >= 7) break;
    }
  }
  return { email, phone };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtmlTags(s: string): string {
  return decodeHtml(String(s).replace(/<[^>]+>/g, "").trim());
}

// ====================================================================
// /agenda — daily agenda for the doctor (occupied + free slots)
// ====================================================================
type AgendaBooking = {
  id: number;
  startHourFormatted: string; // "08:00 AM"
  name: string;
  identification: string;
  identificationTypeShortCode: string;
  stateCode: string;          // PENDING, CANCELED, CONFIRMED, ENDED, etc.
  stateDesc: string;
  bookingComponentName: string;
  planName?: string;
  isCanceled: boolean;
  isBusyTime: boolean;
  isPresential: boolean;
  cancelationReason?: string | null;
  bookingCode?: string;
};

export async function showAgenda(env: Env, chatId: string, dateDashed: string): Promise<void> {
  // dateDashed format: DD-MM-YYYY (with dashes, day first)
  const b = new Bukeala(env);
  const res = await b.getAgenda(dateDashed, AREA_ID, /* includeCanceled */ false);
  const json = await res.json<any>().catch(() => null);
  const bookings: AgendaBooking[] = json?.areas?.[0]?.bookings ?? [];

  // Map non-canceled bookings by start time
  const byTime = new Map<string, AgendaBooking>();
  for (const bk of bookings) {
    if (bk.isCanceled || bk.stateCode === "CANCELED") continue;
    if (bk.isBusyTime) continue;
    byTime.set(bk.startHourFormatted, bk);
  }

  // Generate the slot grid for working hours
  const slots: Array<{ time: string; bk?: AgendaBooking }> = [];
  for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      const time = format12h(h, m);
      slots.push({ time, bk: byTime.get(time) });
    }
  }

  const friendly = json?.defaultDateFormatted ?? dashedToFriendly(dateDashed);
  const occupied = slots.filter((s) => s.bk).length;
  const free = slots.length - occupied;

  const lines: string[] = [
    `<b>Agenda ${friendly}</b>`,
    `${occupied}/${slots.length} ocupados · ${free} libres`,
    "",
  ];
  for (const slot of slots) {
    if (slot.bk) {
      const tag = stateEmoji(slot.bk.stateCode);
      const presential = slot.bk.isPresential ? "" : " 💻";
      const docType = slot.bk.identificationTypeShortCode || "";
      const docNum = slot.bk.identification || "";
      const doc = docType && docNum ? ` <i>${docType} ${docNum}</i>` : "";
      lines.push(
        `${tag} <b>${slot.time}</b> — ${escapeHtml(slot.bk.name)}${doc}${presential}`,
      );
    } else {
      lines.push(`⚪ <b>${slot.time}</b> — Libre`);
    }
  }

  await sendMessage(env, chatId, lines.join("\n"));

  // Feature 4: tap a booking to see full detail
  const kb = await buildAgendaDetailKeyboard(env, chatId, bookings);
  if (kb.inline_keyboard.length > 0) {
    await sendMessage(env, chatId, "Toca una cita para ver detalle completo:", {
      reply_markup: kb,
    });
  }
}

function stateEmoji(stateCode: string): string {
  switch (stateCode) {
    case "PENDING": return "🟡";
    case "PENDING_CONFIRMATION":
    case "PENDING_DATA":
    case "PENDING_PAYMENT": return "🟠";
    case "CONFIRMED": return "🟢";
    case "ADMITTED":
    case "STARTED": return "🔵";
    case "ENDED": return "✅";
    case "NOT_ASSISTED": return "❌";
    case "OVER_BOOKING": return "➕";
    case "PAUSE": return "⛔";
    default: return "📅";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "DD/MM/YYYY" → "DD-MM-YYYY". Returns null if invalid. */
function parseAgendaArgToDashed(input: string): string | null {
  const m = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  const yyyy = m[3];
  return `${dd}-${mm}-${yyyy}`;
}

/** "DD/MM/YYYY" → "DD-MM-YYYY" */
function ddmmyyyyToDdmmYYYY(s: string): string {
  return s.replace(/\//g, "-");
}

/** "06-05-2026" → "06/05/26" */
function dashedToFriendly(dateDashed: string): string {
  const m = dateDashed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return dateDashed;
  return `${m[1]}/${m[2]}/${m[3].slice(2)}`;
}

/** Format hour/min as "08:00 AM" / "12:40 PM" / "01:00 PM" (matches Bukeala) */
function format12h(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${pad2(h12)}:${pad2(m)} ${ampm}`;
}

// ====================================================================
// helpers
// ====================================================================
function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function ddmmyyyy(d: Date) {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function secondsToHHMM(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
}
