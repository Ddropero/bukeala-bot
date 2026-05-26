/**
 * POP CUC — Agenda de cirugías Clínica Colombia (Google Calendar).
 *
 * FUENTE DE VERDAD: los bloques recurrentes que el doctor ya tiene en
 * cirugia@davidduque.com. El bot busca eventos cuyo título contenga
 * "cuc" o "Clínica Universitaria Colombia" Y duren >= 90 min — esos
 * son los bloques de cirugía. Dentro de cada bloque genera slots de 20 min.
 *
 * Ventajas:
 *   - Si el doctor cancela un lunes (borra el bloque) → bot no ofrece slots
 *   - Si extiende el horario → bot lo refleja automáticamente
 *   - Si mueve de 7am a 8am → bot se adapta
 *   - Feriados se auto-detectan (porque el doctor ya borra el bloque)
 *   - Cero hardcoding del horario
 *
 * Flujo (cualquier número de WhatsApp o usuario de Telegram):
 *   1. Usuario escribe "pop cuc"
 *   2. Bot busca los próximos lunes con bloque "Consulta cuc" activo
 *   3. Muestra 4 fechas disponibles
 *   4. Usuario elige fecha → muestra horarios libres dentro del bloque
 *   5. Usuario elige hora → pregunta nombre → pregunta cédula
 *   6. Bot crea evento "POP CUC: {nombre}" dentro del bloque
 *
 * Slots ocupados (otras citas dentro del bloque) se ocultan.
 *
 * Si el calendario no está configurado (GCAL_* no seteado), cae al
 * modo legacy: lunes 7-12:40 hardcoded + sólo guarda en KV.
 *
 * KV:
 *   popcuc:state:{userId}   — state machine (TTL 30 min)
 *   popcuc:list             — backup de entradas (max 100, TTL 90d)
 */
import type { Env } from "./env";
import { getColombianHolidays } from "./holidays";
import { listEvents, createEvent, getServiceAccountEmail, type GCalEvent } from "./gcal";

const POPCUC_RE = /^pop\s*cuc\b/i;
const STATE_TTL = 60 * 30; // 30 min
const TZ_BOGOTA = "America/Bogota";
const TZ_OFFSET_HOURS = -5; // Bogotá no usa DST

// Fallback (cuando GCal no está configurado): lunes 7:00 a 12:40 cada 20 min
const SLOT_HOUR_START = 7;
const SLOT_HOUR_END = 12;
const SLOT_MINUTES_END = 40;
const SLOT_DURATION_MIN = 20;
const WEEKS_TO_OFFER = 8;
const MONDAYS_TO_SHOW = 4;
const SLOTS_TO_SHOW_MAX = 12;

// Detección de "bloques" del doctor en GCal:
//   - Título contiene "cuc" o "Clínica Universitaria Colombia"
//   - Duración >= 90 min (los bloques reales son de 5-6h; las citas son de 20 min)
//   - NO empieza con "POP CUC" (esos son citas del propio bot, no bloques)
const BLOCK_TITLE_REGEX = /cuc|cl[íi]nica universitaria/i;
const POPCUC_EVENT_PREFIX = /^pop\s*cuc/i;
const MIN_BLOCK_DURATION_MIN = 90;

export interface PopCucEntry {
  id: string;
  name: string;
  cedula: string;
  createdBy: string;
  createdAt: number;
  createdAtISO: string;
  scheduledFor?: string;   // ISO datetime de la cita
  scheduledForLabel?: string; // legible: "Lunes 18 May 09:00"
  gcalEventId?: string;
}

interface SlotOption {
  hour: number;
  minute: number;
  isoStart: string;
  isoEnd: string;
  label: string; // "07:00"
}

interface WeekOption {
  mondayISO: string;     // YYYY-MM-DD
  mondayLabel: string;   // "Lunes 18 de Mayo"
}

type PopCucState =
  | { step: "awaiting_week"; startedAt: number; weeks: WeekOption[] }
  | { step: "awaiting_slot"; startedAt: number; mondayISO: string; mondayLabel: string; slots: SlotOption[] }
  | { step: "awaiting_name"; startedAt: number; mondayISO: string; mondayLabel: string; slot: SlotOption }
  | { step: "awaiting_cedula"; startedAt: number; mondayISO: string; mondayLabel: string; slot: SlotOption; name: string };

export function isPopCucTrigger(text: string): boolean {
  return POPCUC_RE.test(text.trim());
}

// ============================================================
// Date helpers (Bogotá timezone, UTC-5 sin DST)
// ============================================================

const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Construye un Date que representa una fecha en Bogotá (UTC-5). */
function bogotaDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  // En UTC, el momento corresponde a Bogotá + 5 horas
  return new Date(Date.UTC(year, month - 1, day, hour - TZ_OFFSET_HOURS, minute));
}

/** YYYY-MM-DD interpretado en Bogotá. */
function todayBogotaISO(): string {
  const now = new Date();
  // Sumamos -5h al UTC para obtener "ahora" en Bogotá
  const bog = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  return bog.toISOString().slice(0, 10);
}

function parseISODate(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(s => parseInt(s, 10));
  return { year: y, month: m, day: d };
}

/** Lunes de la semana que contiene el ISO dado (o hoy si es lunes). */
function getNextMonday(fromISO: string): string {
  const { year, month, day } = parseISODate(fromISO);
  // Construimos en UTC para no inducir efectos de zona horaria local del runtime
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay(); // 0=Dom, 1=Lun, ..., 6=Sab
  const daysUntilMonday = dow === 1 ? 0 : (8 - dow) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const { year, month, day } = parseISODate(iso);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatMondayLabel(iso: string): string {
  const { year, month, day } = parseISODate(iso);
  return `Lunes ${day} de ${MONTHS_ES[month - 1]}${currentYear() === year ? "" : " " + year}`;
}

function currentYear(): number {
  return parseInt(todayBogotaISO().slice(0, 4), 10);
}

/** Genera todos los slots posibles de un lunes dado (sin filtrar disponibilidad). */
function generateAllSlots(mondayISO: string): SlotOption[] {
  const { year, month, day } = parseISODate(mondayISO);
  const slots: SlotOption[] = [];
  for (let h = SLOT_HOUR_START; h <= SLOT_HOUR_END; h++) {
    for (let m = 0; m < 60; m += SLOT_DURATION_MIN) {
      if (h === SLOT_HOUR_END && m > SLOT_MINUTES_END) break;
      const start = bogotaDate(year, month, day, h, m);
      const end = new Date(start.getTime() + SLOT_DURATION_MIN * 60_000);
      slots.push({
        hour: h,
        minute: m,
        isoStart: start.toISOString(),
        isoEnd: end.toISOString(),
        label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      });
    }
  }
  return slots;
}

/** ¿Está este slot ocupado en alguno de los busy periods? */
function isSlotBusy(slot: SlotOption, busy: { start: string; end: string }[]): boolean {
  const slotStart = new Date(slot.isoStart).getTime();
  const slotEnd = new Date(slot.isoEnd).getTime();
  return busy.some(b => {
    const bStart = new Date(b.start).getTime();
    const bEnd = new Date(b.end).getTime();
    return bStart < slotEnd && bEnd > slotStart;
  });
}

// ============================================================
// Availability lookup (GCal)
// ============================================================

interface MondayWithSlots {
  mondayISO: string;
  mondayLabel: string;
  freeSlots: SlotOption[];
}

/**
 * Identifica si un evento de GCal es un "bloque" de cirugía del doctor.
 * Criterios: título contiene cuc/Clínica Universitaria, dura >= 90 min,
 * y NO empieza con "POP CUC" (esos son citas del propio bot).
 */
function isDoctorBlock(ev: GCalEvent): boolean {
  if (!ev.summary || !ev.start?.dateTime || !ev.end?.dateTime) return false;
  if (POPCUC_EVENT_PREFIX.test(ev.summary)) return false;
  if (!BLOCK_TITLE_REGEX.test(ev.summary)) return false;
  const durationMin = (new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime()) / 60_000;
  return durationMin >= MIN_BLOCK_DURATION_MIN;
}

/** Genera slots de 20min dentro de la ventana de un bloque. */
function slotsFromBlock(block: GCalEvent): SlotOption[] {
  const slots: SlotOption[] = [];
  if (!block.start?.dateTime || !block.end?.dateTime) return slots;
  const blockStart = new Date(block.start.dateTime).getTime();
  const blockEnd = new Date(block.end.dateTime).getTime();
  let t = blockStart;
  while (t + SLOT_DURATION_MIN * 60_000 <= blockEnd) {
    const start = new Date(t);
    const end = new Date(t + SLOT_DURATION_MIN * 60_000);
    // Convertir UTC → Bogotá para mostrar HH:MM
    const bog = new Date(start.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
    const hh = String(bog.getUTCHours()).padStart(2, "0");
    const mm = String(bog.getUTCMinutes()).padStart(2, "0");
    slots.push({
      hour: bog.getUTCHours(),
      minute: bog.getUTCMinutes(),
      isoStart: start.toISOString(),
      isoEnd: end.toISOString(),
      label: `${hh}:${mm}`,
    });
    t += SLOT_DURATION_MIN * 60_000;
  }
  return slots;
}

/**
 * Busca los próximos lunes con cupos disponibles.
 *
 * Si GCal está configurado: usa los BLOQUES recurrentes del doctor como
 * fuente de verdad (Consulta cuc, Clínica Universitaria Colombia). Solo
 * ofrece slots dentro de esos bloques, filtrando citas que ya existan
 * dentro de ellos.
 *
 * Si GCal NO está configurado: fallback hardcoded (lunes 7-12:40, saltando
 * feriados colombianos).
 */
async function findAvailableMondays(env: Env, calendarId: string | null): Promise<MondayWithSlots[]> {
  const today = todayBogotaISO();
  const firstMonday = getNextMonday(today);

  // Generamos hasta 8 lunes (lista completa, sin filtro aún)
  const candidates: string[] = [];
  let current = firstMonday;
  for (let i = 0; i < WEEKS_TO_OFFER; i++) {
    candidates.push(current);
    current = addDays(current, 7);
  }
  if (candidates.length === 0) return [];

  const nowMs = Date.now();

  // ============================================================
  // MODO LEGACY (sin GCal): lunes 7-12:40 hardcoded, filtra feriados
  // ============================================================
  if (!calendarId) {
    const years = new Set(candidates.map(c => parseInt(c.slice(0, 4), 10)));
    const holidays = new Set<string>();
    for (const y of years) for (const h of getColombianHolidays(y)) holidays.add(h);
    const result: MondayWithSlots[] = [];
    for (const iso of candidates) {
      if (holidays.has(iso)) continue;
      const allSlots = generateAllSlots(iso);
      const freeSlots = allSlots.filter(s => new Date(s.isoStart).getTime() > nowMs);
      if (freeSlots.length > 0) {
        result.push({ mondayISO: iso, mondayLabel: formatMondayLabel(iso), freeSlots });
      }
      if (result.length >= MONDAYS_TO_SHOW) break;
    }
    return result;
  }

  // ============================================================
  // MODO GCal: usa los bloques del doctor como fuente de verdad
  // ============================================================
  let events: GCalEvent[] = [];
  try {
    const minISO = candidates[0] + "T00:00:00-05:00";
    const maxISO = addDays(candidates[candidates.length - 1], 1) + "T00:00:00-05:00";
    events = await listEvents(env, calendarId, minISO, maxISO);
    console.log(`[popcuc] listEvents: ${events.length} eventos en el rango`);
  } catch (e) {
    console.log("[popcuc] listEvents error:", (e as Error).message);
    return [];
  }

  // Agrupar eventos por lunes (clave: YYYY-MM-DD del lunes al que pertenecen)
  const eventsByMonday: Map<string, GCalEvent[]> = new Map();
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    if (!ev.start?.dateTime) continue;
    // Encontrar el lunes del evento (el evento puede caer en lunes mismo)
    const eventDateBogota = new Date(new Date(ev.start.dateTime).getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
    const isoOfDay = eventDateBogota.toISOString().slice(0, 10);
    if (!candidates.includes(isoOfDay)) continue; // sólo nos importan lunes
    const list = eventsByMonday.get(isoOfDay) || [];
    list.push(ev);
    eventsByMonday.set(isoOfDay, list);
  }

  const result: MondayWithSlots[] = [];
  for (const mondayISO of candidates) {
    const dayEvents = eventsByMonday.get(mondayISO) || [];

    // Separar bloques (ventanas disponibles) de bookings (slots ocupados)
    const blocks = dayEvents.filter(isDoctorBlock);
    const bookings = dayEvents.filter(e => !isDoctorBlock(e));

    if (blocks.length === 0) continue; // no hay bloque ese lunes → no se ofrece

    // Generar slots desde todos los bloques (union, sin duplicados)
    const slotMap = new Map<string, SlotOption>();
    for (const block of blocks) {
      for (const slot of slotsFromBlock(block)) {
        if (!slotMap.has(slot.isoStart)) slotMap.set(slot.isoStart, slot);
      }
    }
    let slots = Array.from(slotMap.values());

    // Ordenar por hora
    slots.sort((a, b) => new Date(a.isoStart).getTime() - new Date(b.isoStart).getTime());

    // Filtrar slots en el pasado
    slots = slots.filter(s => new Date(s.isoStart).getTime() > nowMs);

    // Filtrar slots que se solapan con bookings (otras citas ya agendadas)
    slots = slots.filter(s => !isSlotBusy(s, bookings.filter(e => e.start?.dateTime && e.end?.dateTime).map(e => ({
      start: e.start!.dateTime, end: e.end!.dateTime,
    }))));

    if (slots.length === 0) continue;

    result.push({
      mondayISO,
      mondayLabel: formatMondayLabel(mondayISO),
      freeSlots: slots,
    });
    if (result.length >= MONDAYS_TO_SHOW) break;
  }

  console.log(`[popcuc] ${result.length} lunes con cupos disponibles`);
  return result;
}

// ============================================================
// State machine handler
// ============================================================

/**
 * Maneja un mensaje en el flujo pop cuc. Devuelve la respuesta que debe
 * enviarse al usuario, o null si el mensaje no es parte del flujo.
 */
export async function handlePopCuc(
  env: Env,
  userId: string,
  text: string,
): Promise<{ reply: string; completed?: boolean; entry?: PopCucEntry } | null> {
  const trimmed = text.trim();
  const stateKey = `popcuc:state:${userId}`;
  const calendarId = (env as any).GCAL_CALENDAR_ID || null;

  const stateRaw = await env.STATE.get(stateKey);
  let state: PopCucState | null = stateRaw ? (() => {
    try { return JSON.parse(stateRaw); } catch { return null; }
  })() : null;

  // Cancelar
  const lowerTrim = trimmed.toLowerCase();
  if (state && (lowerTrim === "cancelar" || lowerTrim === "/cancelar" || lowerTrim === "cancel")) {
    await env.STATE.delete(stateKey);
    return { reply: "🚫 Agendamiento cancelado." };
  }

  // ¿Trigger nuevo?
  if (isPopCucTrigger(trimmed)) {
    const afterTrigger = trimmed.replace(POPCUC_RE, "").trim();
    if (afterTrigger.toLowerCase() === "cancel" || afterTrigger.toLowerCase() === "cancelar") {
      await env.STATE.delete(stateKey);
      return { reply: "🚫 Agendamiento cancelado." };
    }

    // Iniciar flujo: mostrar lunes disponibles
    const mondays = await findAvailableMondays(env, calendarId);
    if (mondays.length === 0) {
      return {
        reply: "❌ No hay cupos disponibles en las próximas 8 semanas. Contacte a la clínica directamente.",
      };
    }

    const weeks: WeekOption[] = mondays.map(m => ({
      mondayISO: m.mondayISO,
      mondayLabel: m.mondayLabel,
    }));
    state = { step: "awaiting_week", startedAt: Date.now(), weeks };
    await env.STATE.put(stateKey, JSON.stringify(state), { expirationTtl: STATE_TTL });

    const lines = [
      "🏥 <b>Agenda Cirugías - Clínica Colombia</b>",
      "",
      "Próximas fechas disponibles:",
      "",
      ...weeks.map((w, i) => `${i + 1}. ${w.mondayLabel}`),
      "",
      "<i>Responda con el número de la fecha o escriba <b>cancelar</b>.</i>",
    ];
    return { reply: lines.join("\n") };
  }

  if (!state) return null;

  // ============================================================
  // Step: awaiting_week
  // ============================================================
  if (state.step === "awaiting_week") {
    const choice = parseInt(trimmed.replace(/\D/g, ""), 10);
    if (!choice || choice < 1 || choice > state.weeks.length) {
      return { reply: `Responda con un número entre 1 y ${state.weeks.length}, o "cancelar".` };
    }
    const chosen = state.weeks[choice - 1];

    // Re-consultar slots libres para ese lunes (puede haber cambiado)
    const mondays = await findAvailableMondays(env, calendarId);
    const found = mondays.find(m => m.mondayISO === chosen.mondayISO);
    if (!found || found.freeSlots.length === 0) {
      await env.STATE.delete(stateKey);
      return { reply: "❌ Esa fecha ya no tiene cupos. Escriba <b>pop cuc</b> para ver nuevas opciones." };
    }

    const slotsShown = found.freeSlots.slice(0, SLOTS_TO_SHOW_MAX);
    state = {
      step: "awaiting_slot",
      startedAt: Date.now(),
      mondayISO: chosen.mondayISO,
      mondayLabel: chosen.mondayLabel,
      slots: slotsShown,
    };
    await env.STATE.put(stateKey, JSON.stringify(state), { expirationTtl: STATE_TTL });

    const lines = [
      `📅 <b>${escapeHtml(chosen.mondayLabel)}</b>`,
      "",
      "Horarios disponibles:",
      "",
      ...slotsShown.map((s, i) => `${i + 1}. ${s.label}`),
      "",
      `<i>Responda con el número del horario (1-${slotsShown.length}).</i>`,
    ];
    return { reply: lines.join("\n") };
  }

  // ============================================================
  // Step: awaiting_slot
  // ============================================================
  if (state.step === "awaiting_slot") {
    const choice = parseInt(trimmed.replace(/\D/g, ""), 10);
    if (!choice || choice < 1 || choice > state.slots.length) {
      return { reply: `Responda con un número entre 1 y ${state.slots.length}, o "cancelar".` };
    }
    const chosenSlot = state.slots[choice - 1];
    state = {
      step: "awaiting_name",
      startedAt: Date.now(),
      mondayISO: state.mondayISO,
      mondayLabel: state.mondayLabel,
      slot: chosenSlot,
    };
    await env.STATE.put(stateKey, JSON.stringify(state), { expirationTtl: STATE_TTL });
    return {
      reply: `✅ <b>${escapeHtml(state.mondayLabel)}, ${chosenSlot.label}</b>\n\nNombre completo del paciente:`,
    };
  }

  // ============================================================
  // Step: awaiting_name
  // ============================================================
  if (state.step === "awaiting_name") {
    if (!trimmed || trimmed.length < 2) {
      return { reply: "Nombre vacío. Por favor escriba el nombre completo del paciente." };
    }
    state = {
      step: "awaiting_cedula",
      startedAt: Date.now(),
      mondayISO: state.mondayISO,
      mondayLabel: state.mondayLabel,
      slot: state.slot,
      name: trimmed,
    };
    await env.STATE.put(stateKey, JSON.stringify(state), { expirationTtl: STATE_TTL });
    return {
      reply: `Paciente: <b>${escapeHtml(trimmed)}</b>\n\nNúmero de cédula:`,
    };
  }

  // ============================================================
  // Step: awaiting_cedula
  // ============================================================
  if (state.step === "awaiting_cedula") {
    const cedula = trimmed.replace(/\D/g, "");
    if (!cedula || cedula.length < 5) {
      return { reply: "Cédula inválida. Solo números (mínimo 5 dígitos)." };
    }

    await env.STATE.delete(stateKey);
    const entry = await finalizeBooking(
      env,
      userId,
      state.name,
      cedula,
      state.mondayISO,
      state.mondayLabel,
      state.slot,
      calendarId,
    );
    return {
      reply: formatConfirmation(entry),
      completed: true,
      entry,
    };
  }

  return null;
}

// ============================================================
// Finalize booking
// ============================================================

async function finalizeBooking(
  env: Env,
  userId: string,
  name: string,
  cedula: string,
  mondayISO: string,
  mondayLabel: string,
  slot: SlotOption,
  calendarId: string | null,
): Promise<PopCucEntry> {
  const entry: PopCucEntry = {
    id: cryptoRandomId(),
    name,
    cedula,
    createdBy: userId,
    createdAt: Date.now(),
    createdAtISO: new Date().toISOString(),
    scheduledFor: slot.isoStart,
    scheduledForLabel: `${mondayLabel}, ${slot.label}`,
  };

  // Crear evento en GCal (si está configurado)
  if (calendarId) {
    try {
      // Detectar fuente del registro (WhatsApp del paciente vs Telegram interno)
      const fromWA = userId.startsWith("wa:");
      const phoneOrChat = userId.slice(3); // strip "wa:" o "tg:"
      const description = [
        `<b>POP CUC</b> (bot)`,
        `<b>Paciente:</b> ${name}`,
        `<b>Cédula:</b> ${cedula}`,
        ``,
        `<b>Registrado vía:</b> ${fromWA ? "WhatsApp" : "Telegram"}`,
        `<b>Origen:</b> ${phoneOrChat}`,
        `<b>Fecha registro:</b> ${entry.createdAtISO}`,
      ].join("\n");
      const event = await createEvent(env, calendarId, {
        summary: `POP CUC: ${name}`,
        description,
        start: { dateTime: slot.isoStart, timeZone: TZ_BOGOTA },
        end: { dateTime: slot.isoEnd, timeZone: TZ_BOGOTA },
        reminders: { useDefault: true },
        location: "Clínica Universitaria Colombia, Cra. 66 #23-46, Teusaquillo, Bogotá",
      });
      entry.gcalEventId = event.id;
      console.log(`[popcuc] GCal event created: ${event.id}`);
    } catch (e) {
      console.log("[popcuc] GCal createEvent failed:", (e as Error).message);
      // No abortamos: el booking queda registrado en KV igual
    }
  }

  // Backup en KV (siempre)
  const raw = await env.STATE.get("popcuc:list");
  const list: PopCucEntry[] = raw ? (() => {
    try { return JSON.parse(raw); } catch { return []; }
  })() : [];
  list.push(entry);
  await env.STATE.put("popcuc:list", JSON.stringify(list.slice(-100)), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
  return entry;
}

function formatConfirmation(entry: PopCucEntry): string {
  const lines = [
    `✅ <b>Cita agendada en Clínica Colombia</b>`,
    ``,
    `👤 ${escapeHtml(entry.name)}`,
    `🆔 <code>${escapeHtml(entry.cedula)}</code>`,
  ];
  if (entry.scheduledForLabel) {
    lines.push(`📅 ${escapeHtml(entry.scheduledForLabel)}`);
    lines.push(`⏱ Duración: 20 min`);
  }
  if (!entry.gcalEventId) {
    lines.push(``);
    lines.push(`<i>⚠️ Sin Google Calendar (guardado en backup local).</i>`);
  }
  return lines.join("\n");
}

// ============================================================
// Helpers públicos para Telegram (/cuc_list, /cuc_clear)
// ============================================================

export async function loadPopCucList(env: Env): Promise<PopCucEntry[]> {
  const raw = await env.STATE.get("popcuc:list");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function clearPopCucList(env: Env): Promise<number> {
  const list = await loadPopCucList(env);
  await env.STATE.delete("popcuc:list");
  return list.length;
}

/** Diagnóstico: estado de la configuración de GCal. */
export function getPopCucStatus(env: Env): string {
  const calId = (env as any).GCAL_CALENDAR_ID;
  const saEmail = getServiceAccountEmail(env);
  if (!calId) return "❌ GCAL_CALENDAR_ID no configurado. Solo guardado en KV.";
  return `✅ Calendar ID: <code>${calId}</code>\n📧 Service account: <code>${saEmail}</code>`;
}

// ============================================================
// Utils
// ============================================================

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
