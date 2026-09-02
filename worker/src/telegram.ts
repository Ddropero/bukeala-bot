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
import { showInbox } from "./commands/inbox";
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
import {
  sendHelloWorld,
  normalizeColombianPhone,
  sendAppointmentConfirmation,
  sendAppointmentReminder,
  sendAppointmentCanceled,
  sendAppointmentFollowup,
  sendPostSurgeryCheckin,
  sendText as sendWaText,
} from "./whatsapp";
import { suggestReply, appendHistory, getMode, setMode, type WaMode } from "./claudeAi";
import { loadPendingRequests, clearPendingRequests, processPendingRequests } from "./claudeBookingAgent";
import { getNativeHostEvents, requestRefresh } from "./handlers/nativeHostEvent";
import { requestExtensionSend, getExtensionLastSeenMin } from "./handlers/extensionCommand";
import { isAllowed, isDoctor, getRole, getUserName, listUsers, addUser, removeUser, getDoctorRecipients, type Role } from "./users";
import { encolarComando, cargarComandosPendientes } from "./tgPendingCommands";

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
// Menú con botones, lenguaje natural y tono (amable + asertivo)
// ====================================================================
//
// POR QUÉ: el bot lo usan el doctor y secretarias desde el celular. Un /start
// con 42 comandos y un "Comando no reconocido" seco obligaban a memorizar la
// barra. Los botones y los alias ("hoy", "mañana", "agenda mie") llevan a las
// MISMAS funciones que los comandos: cada botón se traduce a su comando y pasa
// por onText, así no hay lógica duplicada.

/** Botón del menú (callback `menu:<clave>`) → comando equivalente. */
const MENU_ACCIONES: Record<string, string> = {
  hoy: "/hoy",
  manana: "/manana",
  buscar: "/buscar_paciente",
  agendar: "/buscar",
  wa: "/inbox",
  estado: "/estado",
  semana: "/semana",
  comandos: "/comandos",
};

/** `menu:hoy` → "/hoy"; cualquier otro callback → undefined. */
function menuCallbackACommand(data: unknown): string | undefined {
  if (typeof data !== "string" || !data.startsWith("menu:")) return undefined;
  return MENU_ACCIONES[data.slice("menu:".length)];
}

/** Teclado principal. La secretaria no necesita el estado técnico: ve la semana. */
function tecladoMenu(isDoc: boolean) {
  return {
    inline_keyboard: [
      [
        { text: "📅 Hoy", callback_data: "menu:hoy" },
        { text: "📅 Mañana", callback_data: "menu:manana" },
      ],
      [
        { text: "🔎 Buscar paciente", callback_data: "menu:buscar" },
        { text: "➕ Agendar", callback_data: "menu:agendar" },
      ],
      [
        { text: "💬 WhatsApp", callback_data: "menu:wa" },
        isDoc
          ? { text: "⚙️ Estado", callback_data: "menu:estado" }
          : { text: "🗓 Semana", callback_data: "menu:semana" },
      ],
    ],
  };
}

/** Teclado del "no te entendí": lo más pedido + la lista completa. */
function tecladoFallback() {
  return {
    inline_keyboard: [
      [
        { text: "📅 Hoy", callback_data: "menu:hoy" },
        { text: "📅 Mañana", callback_data: "menu:manana" },
      ],
      [
        { text: "🔎 Buscar paciente", callback_data: "menu:buscar" },
        { text: "📋 Todos los comandos", callback_data: "menu:comandos" },
      ],
    ],
  };
}

/**
 * Lenguaje natural mínimo, sin barra: "hoy", "mañana", "agenda mie", "hola"…
 * Devuelve el comando equivalente o null si no reconoce nada. Se compara sin
 * tildes ni signos para que "Mañana!" y "manana" den lo mismo. OJO: onText
 * solo lo aplica cuando NO hay una conversación a medias (una cédula, o un
 * "hola" para un paciente por WhatsApp, no son comandos).
 */
export function aliasNatural(text: string): string | null {
  const t = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^[¡!¿?.,\s]+|[¡!¿?.,\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (!t || t.startsWith("/")) return null;

  const tabla: Array<[RegExp, string]> = [
    [/^(hola+|buenas|buenos dias|buenas tardes|buenas noches|hey|hi|hello|que mas|inicio|start)$/, "/start"],
    [/^(ayuda|help|menu|opciones|botones)$/, "/menu"],
    [/^(comandos|lista de comandos|todos los comandos)$/, "/comandos"],
    [/^(hoy|agenda|agenda (de )?hoy|citas (de )?hoy)$/, "/hoy"],
    [/^(manana|agenda (de )?manana|citas (de )?manana)$/, "/manana"],
    [/^(semana|esta semana|la semana|resumen( de la)? semana|agenda (de la )?semana)$/, "/semana"],
    [/^(estado|como va|como vas|como esta bukeala|esta bukeala|bukeala|sesion|estado bukeala)$/, "/estado"],
    [/^(cancelar|cancelar (una )?cita)$/, "/cancelar"],
    [/^(agendar|agendar (una )?cita|nueva cita|buscar cupo|cupos)$/, "/buscar"],
    [/^(buscar paciente|paciente)$/, "/buscar_paciente"],
  ];
  for (const [re, cmd] of tabla) if (re.test(t)) return cmd;

  // "agenda <fecha>" / "agenda mie" / "agenda miércoles" → /agenda <resto>
  const m = t.match(/^agenda (?:del? |de la )?(.+)$/);
  if (m) {
    const resto = m[1].trim();
    const dia = resto.match(/^(lun|mar|mie|jue|vie|sab|dom)[a-z]*$/);
    return `/agenda ${dia ? dia[1] : resto}`;
  }
  return null;
}

/** Rol para humanos (nada de "secretary"). */
function rolHumano(role: Role | null): string {
  return role === "doctor" ? "doctor" : role === "secretary" ? "secretaria/o" : "sin rol";
}

/**
 * Respuesta única para lo que solo puede hacer el doctor. En vez de un
 * "❌ Solo doctores" seco, dice quién sí puede y ofrece avisarle con un botón.
 * La acción se guarda en KV (10 min) porque callback_data solo admite 64 bytes.
 * Nunca se llega aquí si quien pregunta ES el doctor.
 */
async function soloDoctor(env: Env, chatId: string, accion: string, comando?: string): Promise<void> {
  await env.STATE.put(
    `tg:pedir:${chatId}`,
    JSON.stringify({ accion, comando: comando ?? "" }),
    { expirationTtl: 60 * 10 },
  );
  await sendMessage(
    env,
    chatId,
    `Esto solo lo puede hacer el Dr. David (${escapeHtmlLocal(accion)}).\n¿Le aviso para que lo haga?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🔔 Sí, avísale", callback_data: "pedir:si" },
          { text: "Ahora no", callback_data: "pedir:no" },
        ]],
      },
    },
  );
}

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
      // Auto-recuperación: la VM renueva 24/7, así que pedirle un refresh es
      // mucho mejor que mandar al usuario a loguearse a mano con la extensión
      // (instrucción obsoleta: así se veía "caído sin remedio" durante un blip
      // de sesión de 4-7 min, p. ej. el del 29/jul 07:42 Bogotá).
      await clearState(env, chatId);
      // Qué se puede repetir solo: un comando con barra (o un alias natural
      // que resuelva a uno). Un dato suelto (cédula, email) no se puede
      // repetir sin el estado que acabamos de limpiar, así que no se encola.
      const crudo =
        typeof message?.text === "string" ? message.text.trim() : menuCallbackACommand(callback?.data);
      const reintento = crudo ? (aliasNatural(crudo) ?? crudo) : undefined;
      await wakeSessionAndNotify(env, chatId, reintento?.startsWith("/") ? reintento : undefined);
      return;
    }
    console.error("handler error", err, (err as Error).stack);
    await sendMessage(
      env,
      chatId,
      "❌ Error: " + escapeHtmlLocal((err as Error).message) +
        "\n<i>Prueba de nuevo en un momento. Si se repite, mira /estado.</i>",
    );
  }
}

export async function onText(env: Env, chatId: string, text: string): Promise<void> {
  // POP CUC — agenda interna Clínica Colombia (cualquier usuario autorizado en TG)
  {
    const { handlePopCuc, loadPopCucList, clearPopCucList } = await import("./popCuc");

    // /cuc_list — ver entradas
    if (text === "/cuc_list" || text === "/cuc-list") {
      const list = await loadPopCucList(env);
      if (list.length === 0) {
        await sendMessage(env, chatId, "📋 Lista pop cuc vacía.");
        return;
      }
      const lines = [`📋 <b>Pop cuc — ${list.length} entradas</b>`, ""];
      for (const e of list.slice(-30).reverse()) {
        const when = new Date(e.createdAt).toLocaleString("es-CO", {
          timeZone: "America/Bogota",
          hour12: false,
        });
        const cita = e.scheduledForLabel
          ? `\n  📅 <b>${escapeHtml(e.scheduledForLabel)}</b>${e.gcalEventId ? " ✅" : ""}`
          : "";
        lines.push(`• <b>${escapeHtml(e.name)}</b> · CC <code>${escapeHtml(e.cedula)}</code>${cita}\n  <i>registrado: ${when}</i>`);
      }
      await sendMessage(env, chatId, lines.join("\n"));
      return;
    }

    // /cuc_status — diagnóstico de configuración GCal
    if (text === "/cuc_status") {
      const { getPopCucStatus } = await import("./popCuc");
      await sendMessage(env, chatId, getPopCucStatus(env));
      return;
    }

    // /cuc_clear — limpiar lista (solo doctor)
    if (text === "/cuc_clear") {
      if (!(await isDoctor(env, chatId))) {
        return soloDoctor(env, chatId, "vaciar la lista pop cuc", text);
      }
      const n = await clearPopCucList(env);
      await sendMessage(env, chatId, `🗑️ Lista pop cuc vaciada (${n} entradas borradas).`);
      return;
    }

    // Trigger o flujo activo
    const userId = `tg:${chatId}`;
    const popResult = await handlePopCuc(env, userId, text);
    if (popResult) {
      await sendMessage(env, chatId, popResult.reply);
      return;
    }
  }

  // ---- Conversación a medias: el texto es un dato, no un comando ----------
  // Se leen aquí (una vez) el modo escritura de WhatsApp y el estado del
  // flujo; más abajo se reutilizan. Mientras el bot espera texto libre
  // (cédula, email, celular) o un mensaje para un paciente, NO se aplican los
  // alias: "hola" ahí es un saludo al paciente, no un /start.
  const writingTo = await env.STATE.get(`mainbot:waReplyTo:${chatId}`);
  const state = await loadState(env, chatId);
  const esperaTextoLibre =
    !!writingTo ||
    state.step === "awaiting_customer_id" ||
    state.step === "awaiting_email" ||
    state.step === "awaiting_phone" ||
    state.step === "awaiting_lookup_id";
  if (!esperaTextoLibre && !text.startsWith("/")) {
    const alias = aliasNatural(text);
    if (alias) text = alias;
  }

  if (text === "/start" || text === "/menu") {
    // /start arranca de cero; /menu solo muestra los botones sin tumbar un flujo.
    if (text === "/start") await clearState(env, chatId);
    const role = await getRole(env, chatId);
    const name = await getUserName(env, chatId);
    const isDoc = role === "doctor";
    // El doctor principal se llama "Doctor" en users.ts; para él, su nombre real.
    const nombre = name === "Doctor" ? "Dr. David" : name;
    const saludo = nombre && nombre !== "Desconocido" ? `Hola, ${escapeHtmlLocal(nombre)} 👋` : "Hola 👋";
    const texto =
      text === "/menu"
        ? "¿Qué necesitas? 👇"
        : [
            saludo,
            "",
            isDoc
              ? "Soy tu asistente de agenda. Te muestro la agenda de hoy o de mañana, busco pacientes, agendo o cancelo citas y vigilo que Bukeala esté en línea."
              : "Soy el asistente de agenda del Dr. David. Te muestro la agenda de hoy o de mañana, busco pacientes y agendo o cancelo citas.",
            "",
            "Toca un botón, o escríbeme en palabras: «hoy», «mañana», «agenda mie».",
            "Para ver todo lo que sé hacer: /comandos",
          ].join("\n");
    await sendMessage(env, chatId, texto, { reply_markup: tecladoMenu(isDoc) });
    return;
  }

  // /buscar_paciente — entrada paso a paso al lookup por cédula. Es lo que abre
  // el botón "🔎 Buscar paciente": pide la cédula y luego usa quickLookupPatient,
  // la MISMA función de /p (la búsqueda por nombre sigue sin endpoint en Bukeala).
  if (text === "/buscar_paciente") {
    await clearState(env, chatId);
    await saveState(env, chatId, { step: "awaiting_lookup_id" });
    await sendMessage(
      env,
      chatId,
      "🔎 ¿A quién buscas? Mándame la cédula (solo números).\n<i>Por nombre todavía no se puede; por ahora es por cédula. Para salir: /cancelar_flujo</i>",
    );
    return;
  }

  if (text === "/comandos") {
    const isDoc = await isDoctor(env, chatId);
    const lines = [
      "<b>Todos los comandos</b>",
      "/menu — botones rápidos · /start — saludo",
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
      "/abrir_agenda [perfil] jueves 8:00-12:20 — abrir cupos (solo doctor)",
      "/cancelar_agenda — borrar agendas + avisar pacientes (solo doctor)",
      "/bloquear_dia DD/MM/YYYY [HH:MM-HH:MM] — cerrar un día (solo doctor)",
      "",
      "<b>👥 Pacientes</b>",
      "/p &lt;cédula&gt; — lookup directo del paciente",
      "/buscar_paciente — lo mismo, paso a paso (te pido la cédula)",
      "/recientes — últimos 15 pacientes (botones agendar / citas / WA)",
      "",
      "<b>💬 WhatsApp pacientes</b>",
      "/inbox — vista unificada: TODAS las conversaciones por modo (🤖/✋/👁️)",
      "/contactos — lista todos los contactos WA con botones",
      "/jhon &lt;mensaje&gt; — reenviar alerta a Jhon Morales por WA",
      "/wa_reply &lt;num&gt; &lt;mensaje&gt;",
      "/wa_mode &lt;num&gt; &lt;manual|review|auto&gt;",
      "/wa_status &lt;num&gt;",
      "/wa_pending — solicitudes en cola (Bukeala caído)",
      "/wa_process_pending — re-intentar la cola ahora",
      "/wa_clear_pending — vaciar la cola",
      "/wa_recordar &lt;num&gt; | &lt;nombre&gt; | &lt;fecha&gt; | &lt;hora&gt; | &lt;lugar&gt;",
      "/wa_cancelar_aviso &lt;num&gt; | &lt;nombre&gt; | &lt;fecha&gt; | &lt;hora&gt;",
      "/wa_followup &lt;num&gt; | &lt;nombre&gt;",
      "/wa_postcirugia &lt;num&gt; | &lt;nombre&gt; | &lt;días&gt;",
      "",
      "<b>🏥 Pop cuc (agenda Cirugías Clínica Colombia)</b>",
      "<code>pop cuc</code> — agendar cirugía (muestra lunes 7am-12:40 + Google Calendar)",
      "/cuc_list — ver últimos registros con fecha de cita",
      "/cuc_status — diagnóstico de configuración GCal",
      "/cuc_clear — vaciar lista (solo doctor)",
      "",
      "<b>🔄 Sesión Bukeala</b>",
      "/sesion_renew — pedir nuevo login (cualquiera, abre ventana en PC)",
      "/renovar_navegador — ordenar al navegador del Dr. re-enviar sesión (solo doctor)",
      "/sesion_blackout — heatmap disponibilidad por hora (detecta mantenimientos)",
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
        "/estado — ¿Bukeala en línea? (ping real + captchas hoy + cola)",
        "/agenda_secretaria [fecha] [yo] — agenda con teléfonos y emails",
        "/sesion_stats — estadísticas Native Host",
        "/pendientes_tg — comandos de Telegram en espera (Bukeala caída)",
      );
    }
    lines.push("", "/cancelar_flujo — abortar conversación");
    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  if (text === "/cancelar_flujo") {
    await clearState(env, chatId);
    await sendMessage(env, chatId, "Listo, cancelé lo que estábamos haciendo 👍 /menu para empezar de nuevo.");
    return;
  }

  if (text === "/sesion" || text === "/estado") {
    // Primero lo humano (¿está en línea?, ¿hace cuánto se renovó?); lo técnico
    // solo para el doctor, debajo de "Detalle técnico". Si está caída se pide
    // la renovación aquí mismo: así "ya la estoy renovando" es verdad y el
    // aviso de "✅ renovada" le llega a este chat.
    const esDoc = await isDoctor(env, chatId);
    const s = await loadSession(env);
    if (!s) {
      try { await requestRefresh(env, chatId); } catch { /* best effort */ }
      const lines = [
        "Bukeala: caída 🔴 — ya la estoy renovando",
        "Última renovación: no tengo ninguna sesión guardada",
        "",
        "<i>Te aviso aquí cuando vuelva. Si en 2-3 min no pasa nada: /sesion_renew</i>",
      ];
      if (esDoc) {
        lines.push("", "<i>Detalle técnico</i>", "Sin sesión en KV (SESSIONS): la VM o la extensión deben capturar una nueva.");
      }
      await sendMessage(env, chatId, lines.join("\n"));
      return;
    }
    const ageMin = Math.round((Date.now() - new Date(s.capturedAt).getTime()) / 60000);

    // Verificación EN VIVO: ping real a Bukeala. Antes este comando solo
    // miraba si el blob existía en KV (TTL 12h) — podía decir 🟢 con la
    // sesión muerta hace horas.
    let alive = false;
    let pingNote = "";
    try {
      const b = new Bukeala(env);
      const r = await b.findCustomerPage();
      await r.text();
      alive = true;
      pingNote = `HTTP ${r.status}`;
    } catch (e) {
      alive = false;
      pingNote = e instanceof SessionExpiredError
        ? "sesión rechazada (redirect a login)"
        : `error: ${(e as Error).message.slice(0, 60)}`;
    }

    // Contexto operativo: último evento de la VM, gasto de captcha hoy, cola
    const events = await getNativeHostEvents(env);
    const last = events[events.length - 1];
    let vmLine = "VM: sin eventos reportados";
    if (last) {
      const agoMin = Math.round((Date.now() - new Date(last.at).getTime()) / 60000);
      const via = last.via ? ` vía ${last.via}${last.tgcSource === "worker" ? " (TGC rescatado del Worker)" : ""}` : "";
      vmLine = `VM: ${last.type === "ok" ? "✅ renovó" : "❌ falló"} hace ${agoMin} min${via}${last.type === "ok" ? "" : " — si se repite: /sesion_renew"}`;
    }
    const day = new Date().toISOString().slice(0, 10);
    const [aliveC, tgcC, capC, fallC, errC, pendingRaw] = await Promise.all([
      env.STATE.get(`stats:renew:${day}:ok:alive`),
      env.STATE.get(`stats:renew:${day}:ok:tgc`),
      env.STATE.get(`stats:renew:${day}:ok:captcha`),
      env.STATE.get(`stats:renew:${day}:ok:captcha-fallback`),
      env.STATE.get(`stats:renew:${day}:error`),
      env.STATE.get("wa:pending:list"),
    ]);
    let pendingCount = 0;
    try { pendingCount = pendingRaw ? (JSON.parse(pendingRaw) as unknown[]).length : 0; } catch { /* ignore */ }
    const captchasHoy = (parseInt(capC ?? "0", 10) || 0) + (parseInt(fallC ?? "0", 10) || 0);
    // Gratis = navegador vivo (alive) + reuso de TGC. Ambas evitan el captcha.
    const gratisHoy = (parseInt(aliveC ?? "0", 10) || 0) + (parseInt(tgcC ?? "0", 10) || 0);
    const colaTg = (await cargarComandosPendientes(env)).length;

    if (!alive) {
      try { await requestRefresh(env, chatId); } catch { /* best effort */ }
    }
    const lines = [
      alive ? "Bukeala: en línea ✅" : "Bukeala: caída 🔴 — ya la estoy renovando",
      `Última renovación: hace ${ageMin} min`,
    ];
    if (!alive) lines.push("", "<i>Te aviso aquí cuando vuelva. Si en 2-3 min no pasa nada: /sesion_renew</i>");
    if (esDoc) {
      lines.push(
        "",
        "<i>Detalle técnico</i>",
        `Ping: ${pingNote}`,
        `Sesión: capturada hace ${ageMin} min · ${s.cookies.length} cookies`,
        vmLine,
        `Hoy: ${gratisHoy} renovaciones sin captcha · ${captchasHoy} con captcha · ${parseInt(errC ?? "0", 10) || 0} errores`,
        pendingCount > 0 ? `Cola WhatsApp: ${pendingCount} paciente(s) esperando` : "Cola WhatsApp: vacía",
        colaTg > 0 ? `Cola Telegram: ${colaTg} comando(s) esperando (/pendientes_tg)` : "Cola Telegram: vacía",
      );
    }
    await sendMessage(env, chatId, lines.join("\n"));
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
    await sendMessage(env, chatId, "⏳ Consultando la semana…");
    return handleSemana(env, chatId);
  }
  if (text.startsWith("/agenda ")) {
    const arg = text.slice("/agenda ".length).trim();
    // Try day-abbrev first (lun/mar/mie/...)
    const fromAbbrev = nextWeekdayDateFromAbbrev(arg);
    if (fromAbbrev) return showAgenda(env, chatId, fromAbbrev);
    const dateDashed = parseAgendaArgToDashed(arg);
    if (!dateDashed) {
      await sendMessage(env, chatId, "Casi 🙂 Dime la fecha así: <code>DD/MM/YYYY</code> (ej. <code>13/05/2026</code>) o el día: lun, mar, mie, jue, vie, sab, dom.");
      return;
    }
    return showAgenda(env, chatId, dateDashed);
  }

  // /agenda_secretaria [DD/MM/YYYY] [yo]  → manda la agenda CON CONTACTOS.
  //
  // Sin argumentos: la de mañana, a la secretaria (WhatsApp + Telegram), igual
  // que el cron de la 1pm pero cuando lo pidas. Con "yo": solo a ti, para
  // revisarla antes. El teléfono/email salen del directorio propio, porque
  // Bukeala no los devuelve; a quien no tengamos se marca explícito.
  if (text === "/agenda_secretaria" || text.startsWith("/agenda_secretaria ")) {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "mandar la agenda con contactos a la secretaria", text);
    }
    const args = text.slice("/agenda_secretaria".length).trim().split(/\s+/).filter(Boolean);
    const soloYo = args.some((a) => /^(yo|mi|prueba)$/i.test(a));
    const fechaArg = args.find((a) => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(a));
    const dateDashed = fechaArg ? parseAgendaArgToDashed(fechaArg) : undefined;
    if (fechaArg && !dateDashed) {
      await sendMessage(env, chatId, "Casi 🙂 Dime la fecha así: <code>DD/MM/YYYY</code>.");
      return;
    }

    await sendMessage(env, chatId, "⏳ Armando la agenda…");
    const { secretaryAgendaCron } = await import("./cron/secretaryAgenda");
    const { getDoctorWhatsapp } = { getDoctorWhatsapp: () => (env as any).DOCTOR_WHATSAPP_NUMBER as string | undefined };
    const destino = soloYo ? [getDoctorWhatsapp() ?? ""].filter(Boolean) : undefined;
    if (soloYo && (!destino || destino.length === 0)) {
      await sendMessage(env, chatId, "❌ No hay DOCTOR_WHATSAPP_NUMBER configurado para enviarte la prueba.\n<i>Configúralo con <code>wrangler secret put DOCTOR_WHATSAPP_NUMBER</code>, o corre el comando sin «yo» para mandarla a la secretaria.</i>");
      return;
    }
    try {
      const r = await secretaryAgendaCron(env, {
        dateDashed: dateDashed ?? undefined,
        testWaOnly: destino,
      });
      if (!r) {
        // Sin sesión: pedir la renovación y avisar (no se encola: mandar la
        // agenda a la secretaria no debe repetirse solo).
        await wakeSessionAndNotify(env, chatId);
        return;
      }
      const quien = soloYo ? "a ti" : "a la secretaria";
      await sendMessage(
        env,
        chatId,
        `✅ Agenda de <b>${r.fecha ?? dateDashed ?? "mañana"}</b> enviada ${quien}.
` +
          `${r.citas} cita(s) · WhatsApp: ${r.waSent} enviado(s)` +
          (r.waErrors.length ? `
⚠️ ${escapeHtmlLocal(r.waErrors.slice(0, 2).join(" | "))}` : ""),
      );
    } catch (e) {
      await sendMessage(env, chatId, `❌ No pude armar la agenda: ${escapeHtmlLocal((e as Error).message)}\n<i>Prueba de nuevo en un minuto; si sigue igual, mira /estado.</i>`);
    }
    return;
  }

  // /espejo_calendar [dias] [forzar] [estado] — espejo Bukeala → Google Calendar
  // a demanda (lo mismo que hace el cron cada 2h). "forzar" salta el tope de
  // cancelaciones cuando el Dr. confirma que son reales; "estado" muestra la
  // última corrida sin sincronizar. Solo doctores: escribe en su calendario.
  if (text === "/espejo_calendar" || text.startsWith("/espejo_calendar ") || text.startsWith("/espejo_calendar@")) {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "sincronizar Bukeala con su Google Calendar", text);
    }
    const args = text.replace(/^\/espejo_calendar(@\w+)?/, "").trim().split(/\s+/).filter(Boolean);
    const { espejoCalendarCron, formatearResumenEspejo, ultimaCorridaEspejo } = await import("./cron/espejoCalendar");
    if (args.some((a) => /^estado$/i.test(a))) {
      const u = await ultimaCorridaEspejo(env);
      await sendMessage(
        env,
        chatId,
        u ? `Última corrida: ${u.corridaEn}
${formatearResumenEspejo(u)}` : "Todavía no ha corrido ninguna sincronización.",
      );
      return;
    }
    const forzar = args.some((a) => /^forzar$/i.test(a));
    const diasArg = args.find((a) => /^\d{1,2}$/.test(a));
    await sendMessage(env, chatId, `🪞 Sincronizando Bukeala → Google Calendar${forzar ? " (forzando cancelaciones)" : ""}…`);
    try {
      const r = await espejoCalendarCron(env, {
        dias: diasArg ? parseInt(diasArg, 10) : undefined,
        forzarCancelaciones: forzar,
        origen: "manual",
      });
      await sendMessage(env, chatId, formatearResumenEspejo(r));
    } catch (e) {
      await sendMessage(env, chatId, `❌ Falló el espejo: ${escapeHtmlLocal((e as Error).message)}\n<i>Mira la última corrida con <code>/espejo_calendar estado</code> y vuelve a intentar.</i>`);
    }
    return;
  }

  if (text === "/stats") {
    return showWeeklyStats(env, chatId);
  }

  if (text.startsWith("/buscar_nombre ")) {
    const pattern = text.slice("/buscar_nombre ".length).trim();
    await sendMessage(env, chatId, "⏳ Buscando…");
    return searchByName(env, chatId, pattern);
  }
  if (text === "/buscar_nombre") {
    await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/buscar_nombre &lt;texto&gt;</code> (mínimo 3 caracteres)");
    return;
  }

  if (text.startsWith("/bloquear ")) {
    const args = text.slice("/bloquear ".length).trim();
    return startBloquear(env, chatId, args);
  }
  // /abrir_agenda — abrir cupos en Bukeala (solo doctores)
  if (text === "/abrir_agenda" || text.startsWith("/abrir_agenda ") ||
      text === "/abrir_agenda@agendadavid_bot" || text.startsWith("/abrir_agenda@")) {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "abrir cupos en la agenda", text);
    }
    const argsText = text.replace(/^\/abrir_agenda(@\S+)?/, "").trim();
    const { handleAbrirAgenda } = await import("./commands/abrirAgenda");
    const r = await handleAbrirAgenda(env, argsText);
    await sendMessage(env, chatId, r.reply);
    if (r.needsRenew) await wakeSessionAndNotify(env, chatId);
    return;
  }

  // /cancelar_agenda — borrar agendas (calendarios) + avisar pacientes (solo doctores)
  if (text === "/cancelar_agenda" || text.startsWith("/cancelar_agenda ") ||
      text.startsWith("/cancelar_agenda@")) {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "cancelar agendas y avisar a los pacientes", text);
    }
    const argsText = text.replace(/^\/cancelar_agenda(@\S+)?/, "").trim();
    const { handleCancelarAgenda } = await import("./commands/cancelarAgenda");
    const r = await handleCancelarAgenda(env, argsText);
    await sendMessage(env, chatId, r.reply);
    if (r.needsRenew) await wakeSessionAndNotify(env, chatId);
    return;
  }

  // /bloquear_dia — cerrar un día/horario (deny date), ambos perfiles (solo doctores)
  if (text === "/bloquear_dia" || text.startsWith("/bloquear_dia ") ||
      text.startsWith("/bloquear_dia@")) {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "bloquear un día de la agenda", text);
    }
    const argsText = text.replace(/^\/bloquear_dia(@\S+)?/, "").trim();
    const { handleBloquearDia } = await import("./commands/bloquearDia");
    const r = await handleBloquearDia(env, argsText);
    await sendMessage(env, chatId, r.reply);
    if (r.needsRenew) await wakeSessionAndNotify(env, chatId);
    return;
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
      await sendMessage(env, chatId, `❌ Error ${r.status}: ${escapeHtmlLocal(String(err))}\n<i>Revisa el número (+57 y 10 dígitos) y vuelve a intentar.</i>`);
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
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_reply &lt;número&gt; &lt;mensaje&gt;</code>");
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
    // Sin jerga: rol en español; el chatId (dato técnico, sirve para
    // /add_user) solo se lo mostramos al doctor.
    const lines = [`Eres <b>${escapeHtmlLocal(name)}</b> (${rolHumano(role)})`];
    if (role === "doctor") lines.push(`<i>Tu chatId: ${chatId}</i>`);
    await sendMessage(env, chatId, lines.join("\n"));
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
      return soloDoctor(env, chatId, "agregar usuarios al bot", text);
    }
    const rest = text.slice("/add_user ".length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 3) {
      await sendMessage(
        env,
        chatId,
        "Casi 🙂 Así se usa:\n<code>/add_user &lt;chatId&gt; &lt;doctor|secretary&gt; &lt;nombre&gt;</code>\n\nEjemplo: <code>/add_user 987654321 secretary María Gómez</code>",
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
      await sendMessage(env, chatId, `❌ ${escapeHtmlLocal(result.message)}\n<i>Revisa el chatId (solo números) y el rol (doctor o secretary). Los actuales: /list_users</i>`);
    }
    return;
  }

  // /remove_user <chatId> — remove a user (doctors only)
  if (text.startsWith("/remove_user ")) {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "quitar usuarios del bot", text);
    }
    const targetId = text.slice("/remove_user ".length).trim();
    const result = await removeUser(env, targetId);
    await sendMessage(env, chatId, result.ok ? `✅ ${result.message}` : `❌ ${escapeHtmlLocal(result.message)}\n<i>Mira los chatId con /list_users.</i>`);
    return;
  }

  // /sesion_renew — request the local Native Host to renew the session
  if (text === "/sesion_renew") {
    await requestRefresh(env, chatId);
    await sendMessage(
      env,
      chatId,
      "🔔 <b>Solicitud enviada</b>\n\nEl Native Host la procesará en los próximos 30 segundos.\n\n• Si tienes 2Captcha activo: login automático (~30 seg, sin tu intervención)\n• Si no: se abre Chromium en el PC para login manual\n\n<i>Te aviso aquí cuando termine.</i>",
    );
    return;
  }

  // /renovar_navegador — ordena a la EXTENSIÓN (el navegador del Dr.) que
  // re-envíe la sesión, sin que nadie abra el popup ni haga clic. La extensión
  // sondea /extension/check-send cada ~1 min (chrome.alarms) y al ver la orden
  // corre la renovación completa (CAS heartbeat + captura + envío). OJO: si el
  // navegador NO tiene sesión válida, la extensión NO envía (guardia
  // anti-envenenamiento) y el Worker avisa aquí que hace falta login humano.
  if (text === "/renovar_navegador") {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "renovar la sesión desde su navegador", text);
    }
    await requestExtensionSend(env, chatId);
    const lines = [
      "🖥️ <b>Orden enviada al navegador</b>",
      "",
      "Le pedí a tu navegador que renueve la sesión; en ~1 min te confirmo aquí.",
    ];
    // Advertir ANTES de prometer: si la extensión no sondea hace rato, el
    // navegador probablemente está cerrado y la orden expirará sin efecto.
    const lastSeenMin = await getExtensionLastSeenMin(env);
    if (lastSeenMin === null) {
      lines.push(
        "",
        "⚠️ Tu navegador nunca ha reportado — puede estar cerrado, o la extensión aún no tiene la versión con sondeo remoto (recárgala en brave://extensions).",
      );
    } else if (lastSeenMin > 5) {
      lines.push("", `⚠️ Tu navegador no ha reportado hace ${lastSeenMin} min — puede estar cerrado.`);
    }
    await sendMessage(env, chatId, lines.join("\n"));
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

  // /sesion_blackout — heatmap éxito/fallo por hora Bogotá
  // Útil para detectar ventana de mantenimiento nocturna de Bukeala.
  if (text === "/sesion_blackout") {
    type HourStat = { hour: number; ok: number; fail: number };
    const stats: HourStat[] = [];
    for (let h = 0; h < 24; h++) {
      const okRaw = await env.STATE.get(`bukeala:hourOk:${h}`);
      const failRaw = await env.STATE.get(`bukeala:hourFail:${h}`);
      stats.push({
        hour: h,
        ok: okRaw ? parseInt(okRaw, 10) || 0 : 0,
        fail: failRaw ? parseInt(failRaw, 10) || 0 : 0,
      });
    }
    const totalSamples = stats.reduce((s, x) => s + x.ok + x.fail, 0);
    if (totalSamples === 0) {
      await sendMessage(env, chatId, "📊 Aún sin datos. El tracking inicia cuando el Native Host empieza a reportar eventos.");
      return;
    }
    const lines: string[] = [
      "📊 <b>Disponibilidad Bukeala por hora (Bogotá)</b>",
      `<i>Total muestras: ${totalSamples}</i>`,
      "",
      "<code>Hora  ✅  ❌  Tasa éxito  Barra</code>",
    ];
    for (const s of stats) {
      const total = s.ok + s.fail;
      const rate = total === 0 ? null : (s.ok / total) * 100;
      const rateStr = rate === null ? "—" : `${rate.toFixed(0)}%`;
      const barLen = rate === null ? 0 : Math.round(rate / 10);
      const bar = "█".repeat(barLen) + "·".repeat(10 - barLen);
      const flag = rate !== null && rate < 50 && total >= 3 ? " 🚨" : "";
      const hourStr = `${String(s.hour).padStart(2, "0")}h`;
      const okStr = String(s.ok).padStart(3);
      const failStr = String(s.fail).padStart(3);
      const rateP = rateStr.padStart(4);
      lines.push(`<code>${hourStr} ${okStr} ${failStr}  ${rateP}     ${bar}</code>${flag}`);
    }
    const suspect = stats.filter((s) => {
      const total = s.ok + s.fail;
      return total >= 3 && s.ok / total < 0.5;
    });
    if (suspect.length > 0) {
      lines.push("");
      lines.push("🚨 <b>Horas sospechosas de mantenimiento:</b>");
      lines.push(suspect.map((s) => `${String(s.hour).padStart(2, "0")}:00`).join(", "));
      lines.push("");
      lines.push("<i>Si el patrón se mantiene, ajustamos el cron para evitar esas horas y ahorrar en 2Captcha.</i>");
    } else if (totalSamples >= 20) {
      lines.push("");
      lines.push("💚 No se detectan horas problemáticas — Bukeala parece estable 24/7.");
    } else {
      lines.push("");
      lines.push("<i>Aún pocos datos. Vuelve a chequear en 2-3 días.</i>");
    }
    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  // /sesion_blackout_reset — borra contadores (para empezar tracking desde cero)
  if (text === "/sesion_blackout_reset") {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "reiniciar los contadores de disponibilidad", text);
    }
    for (let h = 0; h < 24; h++) {
      await env.STATE.delete(`bukeala:hourOk:${h}`);
      await env.STATE.delete(`bukeala:hourFail:${h}`);
    }
    await sendMessage(env, chatId, "🔄 Contadores reseteados. El tracking empieza de nuevo.");
    return;
  }

  // /wa_recordar <num> | <nombre> | <fecha> | <hora> | <lugar>
  // Send appointment_reminder template to patient
  if (text.startsWith("/wa_recordar ")) {
    const rest = text.slice("/wa_recordar ".length).trim();
    const parts = rest.split("|").map((s) => s.trim());
    if (parts.length < 5) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_recordar &lt;num&gt; | &lt;nombre&gt; | &lt;fecha&gt; | &lt;hora&gt; | &lt;lugar&gt;</code>\n\nEjemplo: <code>/wa_recordar 3001234567 | Juan Pérez | Miércoles 14/05/26 | 9:00 AM | Calle 80 # 10-43, Cons 506</code>");
      return;
    }
    const [num, name, date, time, place] = parts;
    const r = await sendAppointmentReminder(env, num, name, date, time, place);
    if (r.ok) {
      await sendMessage(env, chatId, `✅ Recordatorio enviado a <code>${normalizeColombianPhone(num)}</code>`);
    } else {
      const err = r.data?.error?.message ?? r.reason ?? "unknown";
      await sendMessage(env, chatId, `❌ No se pudo enviar el recordatorio: ${escapeHtmlLocal(err)}\n<i>Revisa el número (10 dígitos) y que la plantilla exista; si el error es 132001, mira /wa_templates.</i>`);
    }
    return;
  }

  // /wa_cancelar_aviso <num> | <nombre> | <fecha> | <hora>
  if (text.startsWith("/wa_cancelar_aviso ")) {
    const rest = text.slice("/wa_cancelar_aviso ".length).trim();
    const parts = rest.split("|").map((s) => s.trim());
    if (parts.length < 4) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_cancelar_aviso &lt;num&gt; | &lt;nombre&gt; | &lt;fecha&gt; | &lt;hora&gt;</code>");
      return;
    }
    const [num, name, date, time] = parts;
    const r = await sendAppointmentCanceled(env, num, name, date, time);
    await sendMessage(env, chatId, r.ok ? `✅ Aviso de cancelación enviado a <code>${normalizeColombianPhone(num)}</code>` : `❌ No se pudo enviar: ${escapeHtmlLocal(r.data?.error?.message ?? r.reason ?? "unknown")}\n<i>Revisa el número (10 dígitos) y que el paciente tenga WhatsApp.</i>`);
    return;
  }

  // /wa_followup <num> | <nombre>
  if (text.startsWith("/wa_followup ")) {
    const rest = text.slice("/wa_followup ".length).trim();
    const parts = rest.split("|").map((s) => s.trim());
    if (parts.length < 2) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_followup &lt;num&gt; | &lt;nombre&gt;</code>");
      return;
    }
    const [num, name] = parts;
    const r = await sendAppointmentFollowup(env, num, name);
    await sendMessage(env, chatId, r.ok ? `✅ Follow-up enviado a <code>${normalizeColombianPhone(num)}</code>` : `❌ No se pudo enviar: ${escapeHtmlLocal(r.data?.error?.message ?? r.reason ?? "unknown")}\n<i>Revisa el número (10 dígitos) y que el paciente tenga WhatsApp.</i>`);
    return;
  }

  // /wa_templates — lista las plantillas de la WABA que usa el envío (con su
  // código de idioma RAW) para diagnosticar el 132001.
  if (text === "/wa_templates") {
    const { listTemplates } = await import("./handlers/waTemplates");
    const { waba, templates, debug } = await listTemplates(env);
    if (!waba) {
      await sendMessage(env, chatId, `❌ No pude derivar el WABA del envío.\n<code>${escapeHtmlLocal(JSON.stringify(debug).slice(0, 600))}</code>\n<i>Revisa WA_PHONE_ID y el token de Meta (WA_TOKEN).</i>`);
      return;
    }
    const lines = templates.map((t) => `• <b>${t.name}</b> | idioma <code>${t.language}</code> | ${t.status}`);
    await sendMessage(
      env, chatId,
      `📋 <b>WABA del envío:</b> <code>${waba}</code>\n` +
      `(WA_PHONE_ID: <code>${env.WA_PHONE_ID}</code>)\n\n` +
      (lines.length ? lines.join("\n") : "⚠️ Esta WABA NO tiene plantillas — están en otra WABA (causa del 132001)."),
    );
    return;
  }

  // /wa_confirmar <num> | <nombre> | <fecha> | <hora> | <lugar>  (prueba de confirmación)
  if (text.startsWith("/wa_confirmar ")) {
    const rest = text.slice("/wa_confirmar ".length).trim();
    const parts = rest.split("|").map((s) => s.trim());
    if (parts.length < 5) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_confirmar &lt;num&gt; | &lt;nombre&gt; | &lt;fecha&gt; | &lt;hora&gt; | &lt;lugar&gt;</code>\n\nEj: <code>/wa_confirmar 573204933887 | David | Lunes 07/07 | 9:00 AM | Calle 80 #10-43</code>");
      return;
    }
    const [num, name, date, time, place] = parts;
    const r = await sendAppointmentConfirmation(env, num, name, date, time, place);
    await sendMessage(env, chatId, r.ok ? `✅ Confirmación enviada a <code>${normalizeColombianPhone(num)}</code>` : `❌ No se pudo enviar: ${escapeHtmlLocal(r.data?.error?.message ?? r.reason ?? "unknown")}\n<i>Revisa el número (10 dígitos) y que el paciente tenga WhatsApp.</i>`);
    return;
  }

  // /wa_postcirugia <num> | <nombre> | <dias>
  if (text.startsWith("/wa_postcirugia ")) {
    const rest = text.slice("/wa_postcirugia ".length).trim();
    const parts = rest.split("|").map((s) => s.trim());
    if (parts.length < 3) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_postcirugia &lt;num&gt; | &lt;nombre&gt; | &lt;dias_desde_cirugia&gt;</code>");
      return;
    }
    const [num, name, days] = parts;
    const r = await sendPostSurgeryCheckin(env, num, name, parseInt(days, 10));
    await sendMessage(env, chatId, r.ok ? `✅ Check-in post-cirugía enviado a <code>${normalizeColombianPhone(num)}</code>` : `❌ No se pudo enviar: ${escapeHtmlLocal(r.data?.error?.message ?? r.reason ?? "unknown")}\n<i>Revisa el número (10 dígitos) y que el paciente tenga WhatsApp.</i>`);
    return;
  }

  // /wa_mode <number> <manual|review|auto>
  // Switch how the bot handles inbound WhatsApp messages from a contact.
  if (text.startsWith("/wa_mode ")) {
    const rest = text.slice("/wa_mode ".length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/wa_mode &lt;número&gt; &lt;manual|review|auto&gt;</code>\n\n• <b>manual</b>: solo te reenvío.\n• <b>review</b>: Claude propone y tú apruebas.\n• <b>auto</b>: Claude responde directo (con escalación).");
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
      return soloDoctor(env, chatId, "poner un chat en modo auto — tú puedes usar review", text);
    }
    await setMode(env, e164, newMode);
    // Si vuelve a auto, libera el assignee para que la IA tome el control limpio
    if (newMode === "auto") {
      await env.STATE.delete(`wa:assignee:${e164}`);
    }
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

  // /wa_pending  →  list of patients whose request is queued (Bukeala was down)
  if (text === "/wa_pending") {
    const pending = await loadPendingRequests(env);
    if (pending.length === 0) {
      await sendMessage(env, chatId, "✅ Sin solicitudes pendientes en cola.");
      return;
    }
    const lines = [`⏳ <b>${pending.length} solicitud(es) pendiente(s)</b>`, ""];
    for (const p of pending) {
      const when = new Date(p.queuedAt).toLocaleString("es-CO", { timeZone: "America/Bogota", hour12: false });
      lines.push(
        `• <b>${escapeHtml(p.patientName ?? "(sin nombre)")}</b> (CC ${escapeHtml(p.cedula ?? "?")})\n` +
        `   📞 <code>${escapeHtml(p.fromPhone)}</code>\n` +
        `   📋 ${escapeHtml(p.details)}` +
        (p.requestedDate ? `\n   📅 ${escapeHtml(p.requestedDate)}` : "") +
        `\n   🕐 ${escapeHtml(when)}`,
      );
    }
    lines.push("", "<i>Usa /wa_clear_pending para vaciar la cola después de procesarlas.</i>");
    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  // /pendientes_tg  →  comandos de Telegram esperando a que Bukeala vuelva
  // (diagnóstico de la cola de tgPendingCommands.ts; solo doctor).
  if (text === "/pendientes_tg") {
    if (!(await isDoctor(env, chatId))) {
      return soloDoctor(env, chatId, "ver la cola de comandos en espera", text);
    }
    const cola = await cargarComandosPendientes(env);
    if (cola.length === 0) {
      await sendMessage(env, chatId, "✅ No hay comandos de Telegram esperando a Bukeala.");
      return;
    }
    const lines = [`⏳ <b>${cola.length} comando(s) esperando a que Bukeala vuelva</b>`, ""];
    for (const c of cola) {
      const hace = Math.round((Date.now() - c.at) / 60000);
      const quien = await getUserName(env, c.chatId);
      lines.push(
        `• <code>${escapeHtml(c.text)}</code> — ${escapeHtml(quien)} · hace ${hace} min${c.intentos ? ` · reintentos: ${c.intentos}` : ""}`,
      );
    }
    lines.push("", "<i>Se ejecutan solos apenas la sesión se renueve (captura, evento ok o keepAlive).</i>");
    await sendMessage(env, chatId, lines.join("\n"));
    return;
  }

  // /wa_clear_pending  →  empty the queue
  if (text === "/wa_clear_pending") {
    await clearPendingRequests(env);
    await sendMessage(env, chatId, "🗑️ Cola de pendientes vaciada.");
    return;
  }

  // /contactos  →  lista todos los WhatsApp contactos que han escrito al bot
  // (los va guardando whatsappWebhook.ts en wa:contact:{phone}). Cada uno con
  // botones: 📱 Escribir / 📋 Historial / 🤖 Activar IA.
  if (text === "/contactos" || text === "/contacts") {
    return showWaContacts(env, chatId);
  }

  // /inbox  →  vista unificada de TODAS las conversaciones WA agrupadas por modo
  if (text === "/inbox") {
    return showInbox(env, chatId);
  }

  // /jhon <texto>  →  reenvía un mensaje al WhatsApp de Jhon Morales
  // Útil para alertas de descripciones quirúrgicas u otras urgencias.
  if (text.startsWith("/jhon ") || text === "/jhon") {
    if (text === "/jhon") {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/jhon &lt;mensaje&gt;</code>\nEjemplo: <code>/jhon 🚨 Alerta paciente X requiere descripción quirúrgica</code>");
      return;
    }
    const body = text.slice("/jhon ".length).trim();
    if (!body) {
      await sendMessage(env, chatId, "Mensaje vacío.");
      return;
    }
    const r = await sendWaText(env, "573208336978", body);
    if (r.ok) {
      await sendMessage(env, chatId, `✅ Enviado a Jhon Morales (<code>573208336978</code>)`);
    } else {
      const err = r.data?.error?.message ?? "error desconocido";
      await sendMessage(env, chatId, `❌ No se pudo enviar a Jhon: ${escapeHtml(String(err))}\n<i>Probable que esté fuera de ventana 24h. Pídele que te mande "Hola" al WA.</i>`);
    }
    return;
  }

  // /recientes  →  últimos 15 pacientes que agendaste por el bot
  if (text === "/recientes" || text === "/recent") {
    return showRecentPatients(env, chatId);
  }

  // /p <cedula>  →  lookup directo de paciente sin pasar por el flujo de teclado
  if (text.startsWith("/p ") || text === "/p") {
    const cedula = text.slice(2).trim().replace(/\D/g, "");
    if (!cedula) {
      await sendMessage(env, chatId, "Casi 🙂 Así se usa:\n<code>/p &lt;cédula&gt;</code> (ej: <code>/p 80040718</code>)");
      return;
    }
    return quickLookupPatient(env, chatId, cedula);
  }

  // /wa_process_pending  →  manually re-run the queue against current Bukeala session
  if (text === "/wa_process_pending") {
    await sendMessage(env, chatId, "⏳ Procesando cola de pendientes…");
    const r = await processPendingRequests(env);
    const msg =
      `🔄 <b>Resultado</b>\n` +
      `✅ Notificados: ${r.processed}\n` +
      `⏳ Aún pendientes: ${r.remaining}` +
      (r.details.length > 0 ? `\n\n${r.details.slice(0, 8).map((d) => "• " + escapeHtml(d)).join("\n")}` : "");
    await sendMessage(env, chatId, msg);
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

  // Modo "respuesta WhatsApp" — el doctor tocó "📱 Escribir" en /contactos
  // y el siguiente mensaje se reenvía al WhatsApp del paciente.
  // (writingTo se leyó arriba, antes de aplicar los alias)
  if (writingTo) {
    if (text === "/cancelar" || text === "/cancel") {
      await env.STATE.delete(`mainbot:waReplyTo:${chatId}`);
      await sendMessage(env, chatId, "✅ Listo, salí del modo escritura.");
      return;
    }
    const r = await sendWaText(env, writingTo, text);
    if (r.ok) {
      // Guardar la respuesta del doctor en el historial para context cuando
      // se devuelva el contacto a IA.
      try { await appendHistory(env, writingTo, "assistant", text); } catch { /* ignore */ }
      await sendMessage(env, chatId, `✅ Enviado a <code>${writingTo}</code>\n<i>(modo escritura sigue activo · /cancelar para salir)</i>`);
    } else {
      const err = r.data?.error?.message ?? "error desconocido";
      await sendMessage(env, chatId, `❌ No se pudo enviar: ${escapeHtml(String(err))}\n<i>Probable que esté fuera de la ventana 24h. Usa una plantilla con /wa_recordar.</i>`);
    }
    return;
  }

  // Stateful inputs (el estado se leyó arriba, antes de aplicar los alias)
  if (state.step === "awaiting_customer_id") {
    return onCustomerIdEntered(env, chatId, text, state);
  }
  if (state.step === "awaiting_email") {
    return onEmailEntered(env, chatId, text, state);
  }
  if (state.step === "awaiting_phone") {
    return onPhoneEntered(env, chatId, text, state);
  }
  if (state.step === "awaiting_lookup_id") {
    const cedula = text.replace(/\D/g, "");
    if (!cedula) {
      await sendMessage(env, chatId, "Necesito la cédula en números (ej. <code>80040718</code>).\n<i>Para salir: /cancelar_flujo</i>");
      return;
    }
    await clearState(env, chatId);
    return quickLookupPatient(env, chatId, cedula);
  }
  // A mitad de un flujo que espera un botón (tipo de documento, especialidad,
  // cupo, confirmación): decirlo claro en vez de "no te entendí".
  if (state.step !== "idle") {
    await sendMessage(env, chatId, "Estoy esperando que toques una opción del mensaje anterior 👆\n<i>Para salir: /cancelar_flujo</i>");
    return;
  }

  // Fallback amable: solo se llega aquí sin conversación activa.
  await sendMessage(env, chatId, "No te entendí 🤔 ¿Querías alguna de estas?", {
    reply_markup: tecladoFallback(),
  });
}

// ====================================================================
// /contactos — lista de todos los WhatsApp que han escrito al bot
// ====================================================================
async function showWaContacts(env: Env, chatId: string): Promise<void> {
  // Listar todas las keys wa:contact:{phone}
  const list = await env.STATE.list({ prefix: "wa:contact:" });
  if (list.keys.length === 0) {
    await sendMessage(env, chatId, "📭 Sin contactos WhatsApp registrados todavía.");
    return;
  }

  // Cargar cada contacto con su info
  type C = { phone: string; name: string; lastSeen: number; mode: string };
  const contacts: C[] = [];
  for (const k of list.keys) {
    const phone = k.name.slice("wa:contact:".length);
    const raw = await env.STATE.get(k.name);
    if (!raw) continue;
    let info: any = {};
    try { info = JSON.parse(raw); } catch { /* ignore */ }
    const mode = (await env.STATE.get(`wa:mode:${phone}`)) ?? "manual";
    contacts.push({
      phone,
      name: info.name ?? "(sin nombre)",
      lastSeen: typeof info.lastSeenAt === "number" ? info.lastSeenAt : 0,
      mode,
    });
  }

  // Sort por lastSeen desc, top 30
  contacts.sort((a, b) => b.lastSeen - a.lastSeen);
  const top = contacts.slice(0, 30);

  const lines: string[] = [
    `💬 <b>Contactos WhatsApp</b> (${contacts.length} total, mostrando ${top.length})`,
    "",
  ];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const c of top) {
    const ago = c.lastSeen ? relativeTime(c.lastSeen) : "?";
    const modeIcon = c.mode === "auto" ? "🤖" : c.mode === "review" ? "👁️" : "✋";
    lines.push(
      `${modeIcon} <b>${escapeHtml(c.name)}</b> <code>${escapeHtml(c.phone)}</code>\n   <i>${ago}</i>`,
    );
    buttons.push([
      { text: `📱 ${c.name.split(/[, ]/)[0]}`, callback_data: `waw:${c.phone}` },
      { text: "📋", callback_data: `wah:${c.phone}` },
      { text: c.mode === "auto" ? "✋" : "🤖", callback_data: `wam:${c.phone}` },
    ]);
  }
  lines.push("", "<i>Toca 📱 para escribir · 📋 historial · 🤖/✋ alternar IA/manual</i>");

  await sendMessage(env, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: buttons },
  });
}

function relativeTime(ms: number): string {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "hace segundos";
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `hace ${Math.floor(diffSec / 3600)} h`;
  return `hace ${Math.floor(diffSec / 86400)} días`;
}

// ====================================================================
// /recientes — últimos 15 pacientes agendados por el bot
// ====================================================================
async function showRecentPatients(env: Env, chatId: string): Promise<void> {
  const list = await loadRecentPatients(env);
  if (list.length === 0) {
    await sendMessage(env, chatId, "📭 Sin pacientes recientes. Usa /buscar para empezar.");
    return;
  }
  const lines: string[] = [`👥 <b>Pacientes recientes</b> (${list.length})`, ""];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const p of list) {
    const ago = p.lastSeen ? relativeTime(new Date(p.lastSeen).getTime()) : "?";
    lines.push(
      `<b>${escapeHtml(p.name)}</b>\n   ${p.identificationType} <code>${escapeHtml(p.identification)}</code>${p.phone ? ` · 📞 <code>${escapeHtml(p.phone)}</code>` : ""}\n   <i>${ago}</i>`,
    );
    const row: Array<{ text: string; callback_data: string }> = [
      { text: "📅 Agendar", callback_data: `r_book:${p.identification}` },
      { text: "📋 Citas", callback_data: `r_citas:${p.identification}` },
    ];
    if (p.phone) {
      row.push({ text: "📱 WA", callback_data: `waw:${normalizeColombianPhone(p.phone)}` });
    }
    buttons.push(row);
  }
  await sendMessage(env, chatId, lines.join("\n\n"), {
    reply_markup: { inline_keyboard: buttons },
  });
}

// ====================================================================
// /p <cedula> — lookup directo
// ====================================================================
async function quickLookupPatient(env: Env, chatId: string, cedula: string): Promise<void> {
  await sendMessage(env, chatId, `🔍 Buscando <code>${escapeHtml(cedula)}</code>...`);
  const b = new Bukeala(env);
  // Intentar varios tipos de documento
  const tries: Array<{ idType: string; letter: string }> = [
    { idType: "1", letter: "C" },
    { idType: "8", letter: "T" },
    { idType: "9", letter: "R" },
    { idType: "2", letter: "E" },
    { idType: "5", letter: "P" },
  ];
  let found: any = null;
  let foundIdType = "1";
  let foundLetter = "C";
  try {
    for (const t of tries) {
      try {
        const res = await b.findCustomer(t.idType, cedula);
        const j = await res.json<any>().catch(() => null);
        if (j?.result?.code === "EXISTS") {
          found = j?.result?.beanCustomer ?? j?.result ?? {};
          foundIdType = t.idType;
          foundLetter = t.letter;
          break;
        }
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e;
      }
    }
  } catch (e) {
    // Sesión caída: que suba a handleUpdate, que pide la renovación y encola
    // el comando para re-ejecutarlo solo cuando Bukeala vuelva.
    if (e instanceof SessionExpiredError) throw e;
    await sendMessage(env, chatId, `❌ Error: ${escapeHtml((e as Error).message)}\n<i>Prueba de nuevo en un momento.</i>`);
    return;
  }
  if (!found) {
    await sendMessage(env, chatId, `❌ No encontré la cédula <code>${escapeHtml(cedula)}</code> en Bukeala (probé CC, TI, RC, CE y PA).\n<i>Revisa el número; si el paciente es nuevo, hay que crearlo primero en Bukeala.</i>`);
    return;
  }
  const name: string = found.name ?? found.fullName ?? "(sin nombre)";
  const phone: string = found.phone ?? found.cellPhone ?? "";
  const email: string = found.email ?? "";
  const gender: string = (found.gender ?? found.sex ?? "F").toString().toUpperCase().startsWith("M") ? "M" : "F";

  // Guardar en recientes para próximas búsquedas
  try {
    await addRecentPatient(env, {
      name,
      identification: cedula,
      identificationType: foundLetter,
      gender,
      email: email || undefined,
      phone: phone || undefined,
    });
  } catch {/* ignore */}

  const lines = [
    `✅ <b>${escapeHtml(name)}</b>`,
    `Doc: ${foundLetter} <code>${escapeHtml(cedula)}</code>`,
    `Sexo: ${gender}`,
  ];
  if (phone) lines.push(`📞 <code>${escapeHtml(phone)}</code>`);
  if (email) lines.push(`📧 ${escapeHtml(email)}`);

  // ===== Enriquecimiento WhatsApp + cotizaciones (solo si el paciente tiene teléfono) =====
  if (phone) {
    const normPhone = normalizeColombianPhone(phone);

    // Section 1: WA mode + last seen
    const wmRaw = await env.STATE.get(`wa:mode:${normPhone}`);
    const mode = (wmRaw as "auto" | "manual" | "review" | null) ?? "manual";
    const modeIcon = mode === "auto" ? "🤖 IA" : mode === "review" ? "👁️ Review" : "✋ Manual";
    const contactRaw = await env.STATE.get(`wa:contact:${normPhone}`);
    let lastSeen = "";
    if (contactRaw) {
      try {
        const c = JSON.parse(contactRaw);
        if (c.lastSeenAt) lastSeen = ` · última actividad ${relativeTime(c.lastSeenAt)}`;
      } catch {}
    }
    lines.push(`💬 WhatsApp: ${modeIcon}${lastSeen}`);

    // Section 2: Recent WA history (max 5 turnos)
    const historyRaw = await env.STATE.get(`wa:history:${normPhone}`);
    if (historyRaw) {
      try {
        const arr: Array<{ role: string; content: string }> = JSON.parse(historyRaw);
        if (arr.length > 0) {
          const tail = arr.slice(-5);
          lines.push("");
          lines.push(`📋 <b>Últimos ${tail.length} turnos WA:</b>`);
          for (const t of tail) {
            const icon = t.role === "user" ? "👤" : "🤖";
            const txt = (t.content ?? "").toString();
            const trunc = txt.length > 120 ? txt.slice(0, 120) + "…" : txt;
            lines.push(`${icon} <i>${escapeHtml(trunc)}</i>`);
          }
          if (arr.length > 5) lines.push(`<i>+ ${arr.length - 5} turnos previos</i>`);
        }
      } catch {}
    }

    // Section 3: Quote history
    const quoteHistRaw = await env.STATE.get(`quote:history:${normPhone}`);
    if (quoteHistRaw) {
      try {
        const arr: Array<{ ticketId: string; source: string; procedure?: string; amount?: string; status: string; at: number }> = JSON.parse(quoteHistRaw);
        if (arr.length > 0) {
          lines.push("");
          lines.push(`💰 <b>Cotizaciones (${arr.length}):</b>`);
          const recent = arr.slice(-3).reverse();
          for (const q of recent) {
            const date = new Date(q.at).toLocaleDateString("es-CO", { timeZone: "America/Bogota" });
            const proc = q.procedure ? escapeHtml(q.procedure) : "";
            const amt = q.amount ? ` — ${escapeHtml(q.amount.slice(0, 60))}` : "";
            lines.push(`• ${date} · ${q.source} · ${proc}${amt}`);
          }
        }
      } catch {}
    }
  }

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [
    [
      { text: "📅 Agendar", callback_data: `r_book:${cedula}` },
      { text: "📋 Citas", callback_data: `r_citas:${cedula}` },
    ],
  ];
  if (phone) {
    const normPhone = normalizeColombianPhone(phone);
    buttons.push([
      { text: "📱 Escribir WA", callback_data: `waw:${normPhone}` },
      { text: "📤 Recordar", callback_data: `wrem:${cedula}` },
    ]);
  }

  await sendMessage(env, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function onCallback(env: Env, chatId: string, callback: any): Promise<void> {
  const data: string = callback.data ?? "";
  await answerCallback(env, callback.id);

  // Botones del menú (/start, /menu, fallback): se traducen al comando y pasan
  // por onText, para que hagan EXACTAMENTE lo mismo que escribir el comando.
  const menuCmd = menuCallbackACommand(data);
  if (menuCmd) {
    return onText(env, chatId, menuCmd);
  }

  // "¿Le aviso al Dr.?" (ver soloDoctor): sí → mensaje al doctor; no → nada.
  if (data === "pedir:si" || data === "pedir:no") {
    const raw = await env.STATE.get(`tg:pedir:${chatId}`);
    await env.STATE.delete(`tg:pedir:${chatId}`);
    if (data === "pedir:no") {
      await sendMessage(env, chatId, "Vale 👍");
      return;
    }
    if (!raw) {
      await sendMessage(env, chatId, "Ya pasó un rato y perdí el detalle 😅\n<i>Vuelve a escribir el comando y toca el botón de nuevo.</i>");
      return;
    }
    let pedido: { accion: string; comando: string } = { accion: "", comando: "" };
    try { pedido = JSON.parse(raw); } catch { /* ignore */ }
    const quien = await getUserName(env, chatId);
    const aviso =
      `🔔 <b>${escapeHtmlLocal(quien)}</b> pide: ${escapeHtmlLocal(pedido.accion || "(sin detalle)")}` +
      (pedido.comando ? `\n<code>${escapeHtmlLocal(pedido.comando)}</code>` : "");
    let enviados = 0;
    for (const doctorChatId of await getDoctorRecipients(env)) {
      if (doctorChatId === chatId) continue;
      try {
        await sendMessage(env, doctorChatId, aviso);
        enviados++;
      } catch { /* seguir con el resto */ }
    }
    await sendMessage(
      env,
      chatId,
      enviados > 0 ? "Listo, ya le avisé al Dr. David 👍" : "No pude avisarle 😕\n<i>Escríbele directo por WhatsApp.</i>",
    );
    return;
  }

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

  // Callbacks de /recientes y /p:
  //   r_book:<cedula>  → arranca flujo /buscar (agendar) con ese paciente
  //   r_citas:<cedula> → muestra citas activas
  //   wrem:<cedula>    → enviar recordatorio (template) al paciente
  if (data.startsWith("r_book:")) {
    const id = data.slice("r_book:".length);
    await clearState(env, chatId);
    await saveState(env, chatId, { step: "awaiting_doc_type", mode: "buscar" });
    return onRecentPatientSelected(env, chatId, id);
  }
  if (data.startsWith("r_citas:")) {
    const id = data.slice("r_citas:".length);
    await clearState(env, chatId);
    await saveState(env, chatId, { step: "awaiting_doc_type", mode: "citas" });
    return onRecentPatientSelected(env, chatId, id);
  }
  if (data.startsWith("wrem:")) {
    const id = data.slice("wrem:".length);
    const rp = await findRecentPatient(env, id);
    if (!rp || !rp.phone) {
      await sendMessage(env, chatId, "❌ No tengo guardado el teléfono de ese paciente.\n<i>Búscalo primero con /p o agéndalo una vez; ahí queda guardado.</i>");
      return;
    }
    await sendMessage(
      env,
      chatId,
      `📤 Para mandar el recordatorio, copia y completa:\n\n<code>/wa_recordar ${normalizeColombianPhone(rp.phone)} | ${rp.name} | Mié DD/MM/AA | HH:MM | Calle 80 # 10-43 cons 506</code>`,
    );
    return;
  }
  if (data.startsWith("doctor:")) {
    const id = data.slice("doctor:".length);
    try {
      await setActiveDoctor(env, id);
      const d = await getActiveDoctor(env);
      await sendMessage(env, chatId, `✅ Doctor activo: <b>${d.name}</b>`);
    } catch (e) {
      await sendMessage(env, chatId, `❌ No pude cambiar el doctor: ${escapeHtmlLocal((e as Error).message)}\n<i>Prueba de nuevo con /doctor.</i>`);
    }
    return;
  }

  // /contactos buttons:
  //   waw:<phone>  → activa modo escritura: el siguiente texto se envía al WA
  //   wah:<phone>  → muestra historial guardado por la AI
  //   wam:<phone>  → toggle modo manual ↔ auto
  if (data.startsWith("waw:")) {
    const phone = data.slice("waw:".length);
    await env.STATE.put(`mainbot:waReplyTo:${chatId}`, phone, { expirationTtl: 60 * 30 });
    await sendMessage(
      env,
      chatId,
      `✏️ Modo escritura activo para <code>${phone}</code>.\nEl siguiente mensaje que escribas se envía por WhatsApp.\n\n/cancelar para salir sin enviar.`,
    );
    return;
  }
  if (data.startsWith("wah:")) {
    const phone = data.slice("wah:".length);
    const histRaw = await env.STATE.get(`wa:history:${phone}`);
    if (!histRaw) {
      await sendMessage(env, chatId, `📋 Sin historial para <code>${phone}</code>.`);
      return;
    }
    let hist: any[] = [];
    try { hist = JSON.parse(histRaw); } catch { hist = []; }
    if (hist.length === 0) {
      await sendMessage(env, chatId, `📋 Historial vacío para <code>${phone}</code>.`);
      return;
    }
    const lines: string[] = [`📋 <b>Historial WhatsApp ${phone}</b> (${hist.length} turnos)`, ""];
    const tail = hist.slice(-12);
    for (const t of tail) {
      const role = t.role === "user" ? "👤" : "🤖";
      const txt = typeof t.content === "string" ? t.content : "[multimedia/herramienta]";
      lines.push(`${role} ${escapeHtml(txt.slice(0, 200))}`);
    }
    await sendMessage(env, chatId, lines.join("\n\n"));
    return;
  }
  if (data.startsWith("wam:")) {
    const phone = data.slice("wam:".length);
    const cur = (await getMode(env, phone)) ?? "manual";
    const next: WaMode = cur === "auto" ? "manual" : "auto";
    await setMode(env, phone, next);
    await sendMessage(
      env,
      chatId,
      `${next === "auto" ? "🤖 IA activada" : "✋ Modo manual"} para <code>${phone}</code>.`,
    );
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
      return soloDoctor(env, chatId, "activar el modo automático de la IA para ese paciente");
    }
    const phone = data.slice("wa_auto:".length);
    await setMode(env, phone, "auto");
    await env.STATE.delete(`wa:assignee:${phone}`); // libera assignee al volver a IA
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
    // ASSIGNEE: doctor toma control. Próximos mensajes del paciente se ruteen al
    // bot de handoff (consultadavid_bot), unificando la conversación allí.
    await env.STATE.put(`wa:assignee:${phone}`, "doctor", { expirationTtl: 60 * 60 * 24 });
    // Activar modo escritura: el siguiente mensaje en este chat se reenvía al WA
    await env.STATE.put(`mainbot:waReplyTo:${chatId}`, phone, { expirationTtl: 60 * 30 });
    // Dump historial completo para tener contexto
    await dumpHistoryToTgChat(env, chatId, phone);
    await sendMessage(
      env,
      chatId,
      `✏️ Tomaste el control de <code>${phone}</code>.\n\n` +
        `📝 Modo escritura activo: el siguiente mensaje se reenvía al WhatsApp.\n` +
        `Para devolver a la IA: <code>/wa_mode ${phone} auto</code>\n` +
        `Para cancelar el modo escritura: /cancelar`,
    );
    return;
  }
}

/**
 * Dump del historial WA al chat de Telegram donde está el doctor.
 * Versión adaptada del handoffBot.dumpHistoryToChat pero usando el bot principal.
 */
async function dumpHistoryToTgChat(env: Env, chatId: string, phone: string): Promise<void> {
  const raw = await env.STATE.get(`wa:history:${phone}`);
  let hist: Array<{ role: string; content: string }> = [];
  if (raw) {
    try { hist = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (hist.length === 0) {
    await sendMessage(env, chatId, `📜 Sin historial guardado para <code>${phone}</code>.`);
    return;
  }
  const contactRaw = await env.STATE.get(`wa:contact:${phone}`);
  let name = "(sin nombre)";
  if (contactRaw) {
    try { name = JSON.parse(contactRaw).name ?? name; } catch { /* ignore */ }
  }
  const lines: string[] = [
    `📜 <b>Historial conversación con ${escapeHtml(name)}</b>`,
    `📞 <code>${escapeHtml(phone)}</code> · ${hist.length} turnos`,
    "━━━━━━━━━━━━━",
    "",
  ];
  for (const t of hist) {
    const role = t.role === "user" ? "👤" : "🤖";
    const content = (t.content ?? "").toString();
    const trunc = content.length > 400 ? content.slice(0, 400) + "…" : content;
    lines.push(`${role} ${escapeHtml(trunc)}`);
  }
  const fullText = lines.join("\n\n");
  const MAX = 3800;
  if (fullText.length <= MAX) {
    await sendMessage(env, chatId, fullText);
    return;
  }
  let buffer = lines.slice(0, 4).join("\n");
  for (let i = 4; i < lines.length; i++) {
    const next = lines[i];
    if ((buffer + "\n\n" + next).length > MAX) {
      await sendMessage(env, chatId, buffer);
      buffer = next;
    } else {
      buffer = buffer ? buffer + "\n\n" + next : next;
    }
  }
  if (buffer) await sendMessage(env, chatId, buffer);
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
    await sendMessage(env, chatId, `❌ Error ${r.status}: ${escapeHtmlLocal(String(err))}\n<i>Probablemente pasó la ventana de 24 h: usa una plantilla con /wa_recordar.</i>`);
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
    await sendMessage(env, chatId, "Necesito el número de documento, solo números (mínimo 5).\n<i>Para salir: /cancelar_flujo</i>");
    return;
  }

  await sendMessage(env, chatId, "⏳ Buscando al paciente…");
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
      "❌ No pude leer los datos del paciente en Bukeala.\n<i>Prueba de nuevo; si se repite, avísale al Dr. David (puede que Bukeala cambió su página).</i>",
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
    await sendMessage(env, chatId, `❌ No se pudo agendar: ${escapeHtml(stripHtmlTags(msg))}\n<i>Ese cupo pudo ocuparse mientras tanto. Vuelve a buscar con /buscar.</i>`);
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
    await sendMessage(env, chatId, `❌ No se pudo cancelar: ${escapeHtml(stripHtmlTags(msg))}\n<i>Mira con /citas si la cita sigue activa y vuelve a intentar.</i>`);
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
  // Contacto del paciente: Bukeala lo manda en campos distintos según el
  // origen de la cita, por eso se leen todas las variantes.
  email?: string;
  customerEmail?: string;
  phone?: string;
  customerPhone?: string;
  cellPhone?: string | { phoneNumber?: string } | null;
};

/** Teléfono del paciente, mirando todas las variantes que usa Bukeala. */
function bookingPhone(bk: AgendaBooking): string {
  if (typeof bk.cellPhone === "string" && bk.cellPhone.trim()) return bk.cellPhone.trim();
  if (bk.cellPhone && typeof bk.cellPhone === "object" && bk.cellPhone.phoneNumber?.trim()) {
    return bk.cellPhone.phoneNumber.trim();
  }
  if (bk.phone?.trim()) return bk.phone.trim();
  if (bk.customerPhone?.trim()) return bk.customerPhone.trim();
  return "";
}

/** Email del paciente (idem: varias variantes). */
function bookingEmail(bk: AgendaBooking): string {
  for (const c of [bk.email, bk.customerEmail]) {
    if (typeof c === "string" && c.includes("@")) return c.trim();
  }
  return "";
}

export async function showAgenda(env: Env, chatId: string, dateDashed: string): Promise<void> {
  // dateDashed format: DD-MM-YYYY (with dashes, day first)
  await sendMessage(env, chatId, "⏳ Consultando la agenda…");
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

  // Día vacío: decirlo con voz humana. (El teclado de detalle también quedaría
  // vacío: solo lista citas activas.)
  if (occupied === 0) {
    const esDoc = await isDoctor(env, chatId);
    await sendMessage(
      env,
      chatId,
      `📅 <b>${friendly}</b>\n\n${esDoc ? "No tienes" : "No hay"} citas ese día 🎉\n<i>${free} cupos libres</i>`,
    );
    return;
  }

  // Contactos del directorio para todas las cédulas del día, en un solo golpe.
  const { getContactos } = await import("./pacientesContacto");
  const contactos = await getContactos(
    env,
    slots.map((s) => s.bk?.identification ?? "").filter(Boolean),
  );

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
      // Contacto en una 2ª línea. Bukeala NO lo manda (probado), así que sale
      // del directorio propio (`pacientesContacto`), que se llena con los
      // pacientes que escriben por WhatsApp o que agenda el bot.
      // A quien agendó DIRECTO por Colsanitas y nunca escribió no lo tenemos:
      // se marca explícito para que la secretaria sepa a quién buscar a mano.
      const cc = (slot.bk.identification ?? "").replace(/\D/g, "");
      const dir = cc ? contactos[cc] : undefined;
      const tel = bookingPhone(slot.bk) || dir?.telefono || "";
      const mail = bookingEmail(slot.bk) || dir?.email || "";
      const contacto = tel || mail
        ? [
            tel ? `📞 <code>${escapeHtml(tel)}</code>` : "",
            mail ? `✉️ ${escapeHtml(mail)}` : "",
          ].filter(Boolean).join(" · ")
        : "📞 <i>sin contacto — buscar en Bukeala</i>";
      lines.push(`     ${contacto}`);
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

/**
 * Cuando un comando falla por sesión caída —común en modo bajo-demanda—,
 * despierta la sesión Bukeala (la VM hace login) sin que nadie corra
 * /sesion_renew.
 *
 * Si recibe `text` (el comando que falló), lo ENCOLA: cuando la sesión vuelva
 * se re-ejecuta solo y el resultado llega a este chat (tgPendingCommands.ts).
 * Así el usuario no tiene que repetir nada. Sin `text` (p. ej. un botón a
 * mitad de un flujo) solo se pide la renovación y se avisa.
 */
async function wakeSessionAndNotify(env: Env, chatId: string, text?: string): Promise<void> {
  try {
    await requestRefresh(env, chatId);
  } catch (e) {
    console.log("[wakeSession] requestRefresh falló:", (e as Error).message);
  }
  let cola: "nuevo" | "repetido" | "error" = "error";
  if (text) {
    try {
      cola = (await encolarComando(env, chatId, text)) ? "nuevo" : "repetido";
    } catch (e) {
      console.log("[wakeSession] encolar falló:", (e as Error).message);
    }
  }
  const msg =
    text && cola !== "error"
      ? "Bukeala está caída ahora mismo 😕\nYa la estoy renovando. Te mando el resultado aquí apenas vuelva — no tienes que repetir nada." +
        (cola === "repetido" ? "\n<i>(Ya lo tenía anotado.)</i>" : "")
      : "Bukeala está caída ahora mismo 😕\nYa la estoy renovando. Te aviso aquí cuando vuelva (~1-2 min) y ahí repites el último paso.";
  try {
    await sendMessage(env, chatId, msg);
  } catch (e) {
    console.log("[wakeSession] aviso falló:", (e as Error).message);
  }
}
