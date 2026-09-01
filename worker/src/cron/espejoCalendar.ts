/**
 * Espejo Bukeala → Google Calendar.
 *
 * POR QUÉ EXISTE
 * Las citas de Colsanitas viven en Bukeala, un portal ajeno y frágil (Radware
 * bloquea el login automático y la sesión muere cada ~6h). El Dr. quiere ver
 * sus citas en el celular junto a su vida normal, y que sigan existiendo
 * aunque Bukeala se caiga. Así que cada cita activa se copia como evento en su
 * Google Calendar (GCAL_CALENDAR_ID).
 *
 * Dirección ÚNICA: Bukeala → Calendar. Nada de lo que pase en Calendar toca
 * Bukeala; este módulo ni siquiera importa las funciones de escritura.
 *
 * IDEMPOTENCIA — el evento es la fuente de verdad, no KV
 * Cada evento espejado lleva en `extendedProperties.private`:
 *   origen="bukeala"         → marcador para listar todos los espejados de una
 *   bukealaId=<id de cita>   → llave para encontrar el evento de una cita
 *   bukealaHash=<huella>     → huella de los datos de Bukeala que escribimos
 *   bukealaFecha=DD-MM-YYYY  → día de Bukeala al que pertenece la cita
 * Antes de crear se busca por bukealaId (en la ventana y, si no aparece, en
 * todo el calendario). Si KV se borra mañana, la siguiente corrida encuentra
 * los eventos igual y NO duplica. En KV solo va el resumen de la última
 * corrida (diagnóstico) y un candado corto contra corridas simultáneas.
 *
 * EDICIONES MANUALES DEL DR.
 * Un evento se reescribe SOLO cuando la huella cambió, o sea cuando los datos
 * en Bukeala cambiaron de verdad (hora, estado, nombre, plan, contacto…). Si
 * el Dr. movió o editó a mano un evento y Bukeala no cambió, se respeta tal
 * cual — aunque quede desalineado con Bukeala. Decisión consciente: entre
 * pisotear su edición cada 2 horas y tolerar un desfase que él mismo provocó,
 * preferimos lo segundo. Cuando sí toca reescribir, se usa PATCH con título,
 * horas, descripción y propiedades; color, recordatorios, invitados y
 * ubicación que él haya puesto se conservan.
 * Borrar a mano es otra cosa: si elimina un evento espejado y la cita sigue
 * viva en Bukeala, la siguiente corrida lo RESTAURA (el calendario debe
 * reflejar Bukeala; para que una cita desaparezca hay que cancelarla allá).
 *
 * CANCELACIONES — se marcan `status: "cancelled"`, NUNCA `events.delete`
 * Para Calendar "cancelled" equivale a borrado: desaparece de la vista del Dr.
 * y del freeBusy (que usa el agente para cirugías), y `fuentes/gcal.ts` ya lo
 * filtra. Pero a diferencia de un delete, Google conserva el evento y
 * `showDeleted=true` lo devuelve: si la cita vuelve a estar activa (raro, pero
 * pasa), se RESTAURA el mismo evento con `status: "confirmed"` en vez de crear
 * un duplicado. Es la opción reversible, y por eso la elegimos.
 *
 * PROTECCIÓN ANTI-BORRADO MASIVO (lo más importante de este archivo)
 * "No pude leer" NUNCA se interpreta como "no hay citas":
 *   1. Sin sesión en KV, o SessionExpiredError en cualquier día → se aborta
 *      sin escribir nada.
 *   2. Un día cuya respuesta no es 200 / no es JSON / no trae `areas` o
 *      `bookings` cuenta como NO LEÍDO: sus eventos no son candidatos a
 *      cancelación. Si ningún día se pudo leer → abortar.
 *   3. Cero citas activas en toda la ventana → abortar (para un cirujano de
 *      Colsanitas es implausible; si es real, no se pierde nada por esperar).
 *   4. Se lee con includeCanceled=true: cancelar por EVIDENCIA POSITIVA
 *      (Bukeala dice CANCELED) vale más que por ausencia. La ausencia solo
 *      cuenta en un día leído correctamente.
 *   5. Si en una corrida hay más de TOPE_CANCELACIONES candidatos, NO se
 *      escribe nada (ni creaciones) y se avisa al Dr. por Telegram. Él decide
 *      con `/espejo_calendar forzar` si las cancelaciones son reales.
 *   6. Todo lo que se hace es reversible (ver arriba): no existe un camino de
 *      código que borre eventos.
 *
 * ESTRUCTURA
 * `leerAgendaBukeala` (solo lee) y `sincronizarConCalendar` (solo escribe en
 * Calendar) están separadas a propósito: la segunda se puede ejercitar con
 * citas sintéticas sobre un calendario temporal (ver espejoCalendarPrueba.ts)
 * sin depender de que Bukeala esté vivo.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { getDoctorRecipients } from "../users";
import { getContactos, type ContactoPaciente } from "../pacientesContacto";
import { createEvent, listEventsFiltrado, patchEvent, type GCalEvent } from "../gcal";

const AREA_ID = 1074;
const DIAS_DEFAULT = 14;
const DIAS_MAX = 60;
/** Más de esto en UNA corrida huele a lectura rota, no a agenda real. */
export const TOPE_CANCELACIONES = 5;
const TZ = "America/Bogota";
/** Bogotá es UTC-5 todo el año (sin horario de verano). */
const OFFSET_BOGOTA_MS = -5 * 3600 * 1000;
/** Si Bukeala no trae hora de fin (o viene rota), la cita dura esto. */
const DURACION_DEFAULT_MIN = 20;
/** Color fijo (sage) para reconocer de un vistazo lo que viene de Bukeala. */
const COLOR_ID = "2";
/** Súbelo cuando cambie la plantilla de la descripción: fuerza reescritura. */
const FORMATO = "v1";

const PROP_ORIGEN = "origen";
const ORIGEN = "bukeala";
const PROP_ID = "bukealaId";
const PROP_HASH = "bukealaHash";
const PROP_FECHA = "bukealaFecha";

const KV_ULTIMA = "espejo:ultimaCorrida";
const KV_LOCK = "espejo:lock";
const KV_ALERTA_TOPE = "espejo:alertaTope";
const LOCK_TTL_S = 5 * 60;
const ALERTA_TTL_S = 4 * 3600; // = 2 corridas del cron sin repetir la alerta

// ————————————————————————— tipos —————————————————————————

export interface OpcionesEspejo {
  /** Días a espejar desde hoy (Bogotá). Default 14, máximo 60. */
  dias?: number;
  /** Salta el tope de cancelaciones. Solo debe venir de un humano. */
  forzarCancelaciones?: boolean;
  /** "manual" no dispara la alerta de Telegram (el comando ya responde). */
  origen?: "cron" | "manual";
}

export interface ResumenEspejo {
  ok: boolean;
  /** true = NO se escribió nada en Calendar. `motivo` dice por qué. */
  abortado: boolean;
  motivo?: string;
  creados: number;
  actualizados: number;
  restaurados: number;
  sinCambios: number;
  cancelados: number;
  errores: string[];
  ventana: { desde: string; hasta: string; dias: number };
  diasLeidos: number;
  diasFallidos: { fecha: string; motivo: string }[];
  citasActivas: number;
  citasCanceladasEnBukeala: number;
  /** Eventos espejados que ya existían en la ventana (por bukealaId). */
  eventosEspejados: number;
  /** Cancelaciones que se retuvieron por el tope (0 si no aplicó). */
  cancelacionesRetenidas: number;
  duracionMs: number;
  corridaEn: string;
}

/** Subconjunto del booking crudo de Bukeala que usa el espejo. */
type BookingCrudo = {
  id?: number | string;
  bookingCode?: string;
  name?: string;
  identification?: string;
  identificationTypeShortCode?: string;
  startHourFormatted?: string;
  endHourFormatted?: string;
  bookingComponentName?: string;
  planName?: string;
  stateCode?: string;
  stateDesc?: string;
  isCanceled?: boolean;
  isBusyTime?: boolean;
  isPresential?: boolean;
  comment?: string;
};

export interface CitaNormalizada {
  id: string;
  /** DD-MM-YYYY: el día que se le pidió a Bukeala. */
  fecha: string;
  /** "2026-09-01T08:20:00-05:00". Vacío si la hora no se pudo leer. */
  inicio: string;
  fin: string;
  paciente: string;
  documento: string;
  /** Solo dígitos, para el directorio de contactos. */
  cedula: string;
  plan: string;
  codigo: string;
  tipo: string;
  estadoCodigo: string;
  estadoTexto: string;
  presencial: boolean | null;
  notas: string;
  cancelada: boolean;
}

/** Resultado de leer la ventana en Bukeala. Lo consume `sincronizarConCalendar`. */
export interface LecturaBukeala {
  activas: Map<string, CitaNormalizada>;
  canceladas: Map<string, CitaNormalizada>;
  /** Días (DD-MM-YYYY) que respondieron bien. Solo en estos cuenta la ausencia. */
  diasOk: Set<string>;
  diasFallidos: { fecha: string; motivo: string }[];
  /** Si viene, la lectura murió globalmente (sesión) y hay que abortar. */
  abortarPor?: string;
}

export interface Ventana {
  /** Medianoche UTC del día calendario de hoy en Bogotá. */
  hoy: Date;
  dias: number;
  /** DD-MM-YYYY de cada día de la ventana, en orden. */
  fechas: string[];
}

type Accion =
  | { tipo: "crear"; cita: CitaNormalizada; cuerpo: GCalEvent; etiqueta: string }
  | { tipo: "actualizar"; ev: GCalEvent; cuerpo: GCalEvent; etiqueta: string }
  | { tipo: "restaurar"; ev: GCalEvent; cuerpo: GCalEvent; etiqueta: string }
  | { tipo: "cancelar"; ev: GCalEvent; etiqueta: string };

// ————————————————————— fechas y horas (Bogotá) —————————————————————

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Medianoche UTC del día calendario que es HOY en Bogotá. */
export function hoyBogota(): Date {
  const d = new Date(Date.now() + OFFSET_BOGOTA_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function sumarDias(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

/** Date (medianoche UTC) → DD-MM-YYYY, el formato que pide getAgenda. */
export function aDashed(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** DD-MM-YYYY → YYYY-MM-DD (para armar el dateTime del evento). */
export function dashedAIso(fecha: string): string {
  const m = fecha.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : fecha;
}

/** "08:20 AM" → minutos desde medianoche. null si no calza. */
function parseHora12(s: string): number | null {
  const m = (s ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h === 12) h = 0;
  if (m[3].toUpperCase() === "P") h += 12;
  return h * 60 + min;
}

/** Instante local de Bogotá con offset explícito; Google lo respeta tal cual. */
export function isoLocal(fechaIso: string, minutos: number): string {
  const m = Math.min(Math.max(minutos, 0), 23 * 60 + 59);
  return `${fechaIso}T${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00-05:00`;
}

/** ISO cualquiera → DD-MM-YYYY del día en Bogotá. */
function fechaBogotaDe(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return aDashed(new Date(t + OFFSET_BOGOTA_MS));
}

/** "2026-09-01T08:20:00-05:00" → "01/09 08:20" para etiquetas de reporte. */
function etiquetaHora(iso?: string): string {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : iso ?? "";
}

export function armarVentana(diasPedidos?: number): Ventana {
  const n = Number.isFinite(diasPedidos as number) ? (diasPedidos as number) : DIAS_DEFAULT;
  const dias = Math.min(Math.max(Math.floor(n), 1), DIAS_MAX);
  const hoy = hoyBogota();
  const fechas: string[] = [];
  for (let i = 0; i < dias; i++) fechas.push(aDashed(sumarDias(hoy, i)));
  return { hoy, dias, fechas };
}

export function resumenVacio(v: Ventana): ResumenEspejo {
  return {
    ok: false,
    abortado: false,
    creados: 0,
    actualizados: 0,
    restaurados: 0,
    sinCambios: 0,
    cancelados: 0,
    errores: [],
    ventana: { desde: v.fechas[0], hasta: v.fechas[v.fechas.length - 1], dias: v.dias },
    diasLeidos: 0,
    diasFallidos: [],
    citasActivas: 0,
    citasCanceladasEnBukeala: 0,
    eventosEspejados: 0,
    cancelacionesRetenidas: 0,
    duracionMs: 0,
    corridaEn: new Date().toISOString(),
  };
}

// ————————————————————— lectura de Bukeala —————————————————————

/**
 * Lee un día. Devuelve `ok:false` (día NO leído) ante cualquier cosa que no
 * sea un 200 con la forma esperada: así una respuesta rota jamás se confunde
 * con "ese día no tiene citas". SessionExpiredError se deja subir: es global.
 */
async function leerDia(
  b: Bukeala,
  fecha: string,
): Promise<{ ok: true; bookings: BookingCrudo[] } | { ok: false; motivo: string }> {
  const res = await b.getAgenda(fecha, AREA_ID, /* includeCanceled */ true);
  if (res.status !== 200) return { ok: false, motivo: `HTTP ${res.status}` };
  const json = await res.json<any>().catch(() => null);
  if (!json || typeof json !== "object") return { ok: false, motivo: "respuesta no es JSON" };
  if (!Array.isArray(json.areas)) return { ok: false, motivo: "respuesta sin 'areas'" };
  const bookings = json.areas[0]?.bookings;
  if (!Array.isArray(bookings)) return { ok: false, motivo: "respuesta sin 'bookings'" };
  return { ok: true, bookings };
}

function normalizar(bk: BookingCrudo, fecha: string): CitaNormalizada | null {
  // Los bloqueos de agenda ("busy time") no son citas de pacientes.
  if (!bk || bk.isBusyTime) return null;
  const id = bk.id != null && String(bk.id).trim() ? String(bk.id).trim() : "";
  if (!id) return null;

  const iso = dashedAIso(fecha);
  const iniMin = parseHora12(bk.startHourFormatted ?? "");
  let finMin = parseHora12(bk.endHourFormatted ?? "");
  if (iniMin != null && (finMin == null || finMin <= iniMin)) finMin = iniMin + DURACION_DEFAULT_MIN;

  const tipoDoc = (bk.identificationTypeShortCode ?? "").trim();
  const numDoc = (bk.identification ?? "").trim();
  return {
    id,
    fecha,
    inicio: iniMin != null ? isoLocal(iso, iniMin) : "",
    fin: iniMin != null && finMin != null ? isoLocal(iso, finMin) : "",
    paciente: (bk.name ?? "").trim(),
    documento: [tipoDoc, numDoc].filter(Boolean).join(" "),
    cedula: numDoc.replace(/\D/g, ""),
    plan: (bk.planName ?? "").trim(),
    codigo: (bk.bookingCode ?? "").trim(),
    tipo: (bk.bookingComponentName ?? "").trim(),
    estadoCodigo: (bk.stateCode ?? "").trim(),
    estadoTexto: (bk.stateDesc ?? "").trim(),
    presencial: typeof bk.isPresential === "boolean" ? bk.isPresential : null,
    notas: (bk.comment ?? "").trim(),
    cancelada: !!bk.isCanceled || bk.stateCode === "CANCELED",
  };
}

/** Lee la ventana completa en Bukeala, día por día y en serie (no castigar la sesión). */
export async function leerAgendaBukeala(env: Env, fechas: string[]): Promise<LecturaBukeala> {
  const out: LecturaBukeala = { activas: new Map(), canceladas: new Map(), diasOk: new Set(), diasFallidos: [] };
  const b = new Bukeala(env);
  for (const fecha of fechas) {
    let lectura: Awaited<ReturnType<typeof leerDia>>;
    try {
      lectura = await leerDia(b, fecha);
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        out.abortarPor = `sesión de Bukeala expirada al leer ${fecha}`;
        return out;
      }
      lectura = { ok: false, motivo: (e as Error).message };
    }
    if (!lectura.ok) {
      out.diasFallidos.push({ fecha, motivo: lectura.motivo });
      console.log(`[espejo] día ${fecha} NO leído: ${lectura.motivo}`);
      continue;
    }
    out.diasOk.add(fecha);
    for (const bk of lectura.bookings) {
      const c = normalizar(bk, fecha);
      if (!c) continue;
      if (c.cancelada) out.canceladas.set(c.id, c);
      else if (!out.activas.has(c.id)) out.activas.set(c.id, c);
    }
  }
  // Si una cita aparece activa y cancelada a la vez (duplicado raro), gana activa.
  for (const id of out.activas.keys()) out.canceladas.delete(id);
  return out;
}

// ————————————————————— el evento —————————————————————

/** Huella corta (SHA-256 truncado) de exactamente lo que escribimos. */
async function huella(cita: CitaNormalizada, contacto?: ContactoPaciente): Promise<string> {
  const partes = [
    FORMATO,
    cita.paciente,
    cita.inicio,
    cita.fin,
    cita.documento,
    cita.plan,
    cita.codigo,
    cita.tipo,
    cita.estadoTexto,
    cita.presencial,
    cita.notas,
    contacto?.telefono ?? "",
    contacto?.email ?? "",
  ];
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(partes)));
  return [...new Uint8Array(buf)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function telLegible(tel?: string): string {
  const d = (tel ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.startsWith("57") && d.length === 12 ? `+${d}` : d;
}

function descripcion(cita: CitaNormalizada, contacto?: ContactoPaciente): string {
  const l: string[] = [];
  l.push(`🪪 ${cita.documento || "sin documento"}`);
  if (cita.tipo) l.push(`🏥 ${cita.tipo}`);
  l.push(`📋 Plan: ${cita.plan || "—"}`);
  l.push(`🔖 Código: ${cita.codigo || "—"}`);
  l.push(`📌 Estado: ${cita.estadoTexto || cita.estadoCodigo || "—"}`);
  if (cita.presencial !== null) l.push(cita.presencial ? "📍 Presencial" : "💻 Virtual");
  // Bukeala no expone teléfono ni email: salen del directorio propio. Cuando
  // no hay, se dice explícito para que nadie crea que el dato "se perdió".
  l.push(`📞 ${telLegible(contacto?.telefono) || "sin teléfono en el directorio"}`);
  l.push(`✉️ ${contacto?.email || "sin email en el directorio"}`);
  if (cita.notas) l.push(`📝 ${cita.notas}`);
  l.push("");
  l.push(
    "— Espejo automático desde Bukeala (Colsanitas). Los cambios se hacen en " +
      "Bukeala; este evento se reescribe solo cuando la cita cambia allá.",
  );
  return l.join("\n");
}

/** Cuerpo completo del evento (para crear). Para PATCH se toma un subconjunto. */
function construirEvento(cita: CitaNormalizada, contacto: ContactoPaciente | undefined, hash: string): GCalEvent {
  return {
    summary: cita.paciente || "Paciente sin nombre",
    description: descripcion(cita, contacto),
    start: { dateTime: cita.inicio, timeZone: TZ },
    end: { dateTime: cita.fin, timeZone: TZ },
    extendedProperties: {
      private: {
        [PROP_ORIGEN]: ORIGEN,
        [PROP_ID]: cita.id,
        [PROP_HASH]: hash,
        [PROP_FECHA]: cita.fecha,
      },
    },
    colorId: COLOR_ID,
    // Sin recordatorios: un día de consultorio son 8-10 pacientes seguidos y
    // una alarma por cada uno es ruido. Solo se fija al crear; si el Dr. le
    // pone recordatorio a uno, el PATCH no lo toca.
    reminders: { useDefault: false, overrides: [] },
  };
}

/** Lo único que el espejo se atreve a reescribir en un evento existente. */
function parcheDe(cuerpo: GCalEvent): Partial<GCalEvent> {
  return {
    summary: cuerpo.summary,
    description: cuerpo.description,
    start: cuerpo.start,
    end: cuerpo.end,
    extendedProperties: cuerpo.extendedProperties,
  };
}

/** Entre varios eventos con el mismo bukealaId, el vivo le gana al cancelado. */
function elegirEvento(evs: GCalEvent[]): GCalEvent | undefined {
  const vivo = evs.find((e) => e.status !== "cancelled" && !!e.id);
  return vivo ?? evs.find((e) => !!e.id);
}

// ————————————————————— sincronización con Calendar —————————————————————

/**
 * Aplica la lectura sobre el calendario. Llena `r` y devuelve `motivo` si
 * abortó (en cuyo caso NO escribió nada). Es pura respecto a Bukeala: solo ve
 * la `lectura` que le pasan, por eso se puede probar con citas sintéticas.
 */
export async function sincronizarConCalendar(
  env: Env,
  calId: string,
  lectura: LecturaBukeala,
  v: Ventana,
  opts: OpcionesEspejo,
  r: ResumenEspejo,
): Promise<string | undefined> {
  const abortar = (motivo: string): string => {
    r.abortado = true;
    r.ok = false;
    r.motivo = motivo;
    return motivo;
  };

  r.diasFallidos = lectura.diasFallidos;
  r.diasLeidos = lectura.diasOk.size;
  r.citasActivas = lectura.activas.size;
  r.citasCanceladasEnBukeala = lectura.canceladas.size;

  if (lectura.abortarPor) return abortar(lectura.abortarPor);
  if (lectura.diasOk.size === 0) {
    return abortar(`no se pudo leer ningún día de Bukeala (${lectura.diasFallidos[0]?.motivo ?? "?"})`);
  }
  if (lectura.activas.size === 0) {
    return abortar(`Bukeala devolvió CERO citas activas en ${lectura.diasOk.size} día(s): sospechoso`);
  }
  const { activas, canceladas: canceladasBukeala, diasOk } = lectura;

  // 1. Directorio de contactos (Bukeala no da teléfono ni email).
  const dir = await getContactos(env, [...activas.values()].map((c) => c.cedula));

  // 2. Eventos espejados que ya existen en la ventana (incluidos cancelados).
  const timeMin = new Date(v.hoy.getTime() - OFFSET_BOGOTA_MS).toISOString();
  const timeMax = new Date(sumarDias(v.hoy, v.dias).getTime() - OFFSET_BOGOTA_MS).toISOString();
  let eventos: GCalEvent[];
  try {
    eventos = await listEventsFiltrado(env, calId, {
      timeMin,
      timeMax,
      privateProps: { [PROP_ORIGEN]: ORIGEN },
      showDeleted: true,
    });
  } catch (e) {
    return abortar(`no se pudo leer Google Calendar: ${(e as Error).message}`);
  }
  const porId = new Map<string, GCalEvent>();
  for (const ev of eventos) {
    const id = ev.extendedProperties?.private?.[PROP_ID];
    if (!id || !ev.id) continue;
    const previo = porId.get(id);
    if (!previo || (previo.status === "cancelled" && ev.status !== "cancelled")) porId.set(id, ev);
  }
  r.eventosEspejados = porId.size;

  // 3. Armar el plan SIN escribir nada todavía.
  const plan: Accion[] = [];
  for (const cita of activas.values()) {
    if (!cita.inicio) {
      r.errores.push(`${cita.fecha} ${cita.paciente}: hora ilegible, no se espeja`);
      continue;
    }
    const contacto = dir[cita.cedula];
    const hash = await huella(cita, contacto);
    const cuerpo = construirEvento(cita, contacto, hash);
    const etiqueta = `${etiquetaHora(cita.inicio)} ${cita.paciente}`;

    let ev = porId.get(cita.id);
    if (!ev) {
      // No está en la ventana: puede que el Dr. lo haya arrastrado a otra
      // semana. Buscar en todo el calendario antes de crear un duplicado.
      try {
        ev = elegirEvento(await listEventsFiltrado(env, calId, { privateProps: { [PROP_ID]: cita.id }, showDeleted: true }));
      } catch (e) {
        r.errores.push(`${etiqueta}: buscar por id falló (${(e as Error).message})`);
        continue;
      }
    }

    if (!ev) {
      plan.push({ tipo: "crear", cita, cuerpo, etiqueta });
    } else if (ev.status === "cancelled") {
      plan.push({ tipo: "restaurar", ev, cuerpo, etiqueta });
    } else if (ev.extendedProperties?.private?.[PROP_HASH] === hash) {
      r.sinCambios++;
    } else {
      plan.push({ tipo: "actualizar", ev, cuerpo, etiqueta });
    }
  }

  // Candidatos a cancelación: evento vivo cuya cita ya no está activa, y
  // (a) Bukeala la reporta CANCELED, o (b) no aparece en un día que SÍ se
  // leyó bien. Un día no leído no produce cancelaciones jamás.
  for (const [id, ev] of porId) {
    if (ev.status === "cancelled" || activas.has(id)) continue;
    const fechaEv = ev.extendedProperties?.private?.[PROP_FECHA] || fechaBogotaDe(ev.start?.dateTime);
    const evidenciaPositiva = canceladasBukeala.has(id);
    const ausenteEnDiaLeido = !!fechaEv && diasOk.has(fechaEv);
    if (evidenciaPositiva || ausenteEnDiaLeido) {
      plan.push({ tipo: "cancelar", ev, etiqueta: `${etiquetaHora(ev.start?.dateTime)} ${ev.summary ?? ""}`.trim() });
    }
  }

  const cancelaciones = plan.filter((a): a is Extract<Accion, { tipo: "cancelar" }> => a.tipo === "cancelar");
  if (cancelaciones.length > TOPE_CANCELACIONES && !opts.forzarCancelaciones) {
    // Ni siquiera se crean eventos: si la lectura vino incompleta, lo que
    // "hay que crear" también puede ser basura.
    r.cancelacionesRetenidas = cancelaciones.length;
    await alertarTope(env, cancelaciones, opts.origen);
    return abortar(
      `${cancelaciones.length} cancelaciones superan el tope de ${TOPE_CANCELACIONES}; ` +
        `si son reales: /espejo_calendar forzar`,
    );
  }

  // 4. Ejecutar: primero lo que agrega, al final lo que quita.
  for (const a of plan) {
    if (a.tipo === "cancelar") continue;
    try {
      if (a.tipo === "crear") {
        await createEvent(env, calId, a.cuerpo);
        r.creados++;
      } else if (a.tipo === "restaurar") {
        await patchEvent(env, calId, a.ev.id!, { ...parcheDe(a.cuerpo), status: "confirmed" });
        r.restaurados++;
      } else {
        await patchEvent(env, calId, a.ev.id!, parcheDe(a.cuerpo));
        r.actualizados++;
      }
    } catch (e) {
      r.errores.push(`${a.tipo} ${a.etiqueta}: ${(e as Error).message}`);
    }
  }
  for (const a of cancelaciones) {
    try {
      await patchEvent(env, calId, a.ev.id!, { status: "cancelled" });
      r.cancelados++;
    } catch (e) {
      r.errores.push(`cancelar ${a.etiqueta}: ${(e as Error).message}`);
    }
  }
  r.ok = r.errores.length === 0;
  return undefined;
}

// ————————————————————— el cron —————————————————————

export async function espejoCalendarCron(env: Env, opts: OpcionesEspejo = {}): Promise<ResumenEspejo> {
  const t0 = Date.now();
  const v = armarVentana(opts.dias);
  const r = resumenVacio(v);

  const terminar = async (guardar = true): Promise<ResumenEspejo> => {
    r.duracionMs = Date.now() - t0;
    if (guardar) {
      try {
        await env.STATE.put(KV_ULTIMA, JSON.stringify(r), { expirationTtl: 7 * 86400 });
      } catch { /* diagnóstico, no bloquea */ }
    }
    console.log(
      `[espejo] ${r.abortado ? "ABORTADO: " + r.motivo : "ok"} · creados=${r.creados} actualizados=${r.actualizados} ` +
        `restaurados=${r.restaurados} sinCambios=${r.sinCambios} cancelados=${r.cancelados} errores=${r.errores.length} ` +
        `(${r.duracionMs} ms)`,
    );
    return r;
  };
  const abortar = (motivo: string, guardar = true): Promise<ResumenEspejo> => {
    r.abortado = true;
    r.ok = false;
    r.motivo = motivo;
    return terminar(guardar);
  };

  // 0. Precondiciones: sin Calendar o sin sesión no hay nada que hacer.
  if (!env.GCAL_SERVICE_ACCOUNT_JSON || !env.GCAL_CALENDAR_ID) {
    return abortar("Google Calendar no configurado (GCAL_SERVICE_ACCOUNT_JSON / GCAL_CALENDAR_ID)");
  }
  const calId = env.GCAL_CALENDAR_ID;
  if (!(await loadSession(env))) {
    return abortar("sin sesión de Bukeala en KV");
  }

  // Candado corto: si el cron y el comando manual coinciden, los dos verían
  // "no existe" y crearían el evento dos veces. KV no es atómico, pero la
  // ventana de carrera es de milisegundos frente a corridas cada 2 horas.
  const lock = await env.STATE.get(KV_LOCK);
  if (lock && Date.now() - parseInt(lock, 10) < LOCK_TTL_S * 1000) {
    // No se guarda como "última corrida": taparía el resumen de la corrida real.
    return abortar("otra corrida del espejo está en curso; reintenta en unos minutos", false);
  }
  await env.STATE.put(KV_LOCK, String(Date.now()), { expirationTtl: LOCK_TTL_S });

  try {
    const lectura = await leerAgendaBukeala(env, v.fechas);
    await sincronizarConCalendar(env, calId, lectura, v, opts, r);
  } catch (e) {
    // Nada de lo anterior debería lanzar, pero si pasa, que quede en el resumen.
    r.abortado = true;
    r.ok = false;
    r.motivo = `error inesperado: ${(e as Error).message}`;
  } finally {
    await env.STATE.delete(KV_LOCK).catch(() => {});
  }

  return terminar();
}

// ————————————————————— avisos —————————————————————

async function notificarDoctores(env: Env, text: string): Promise<void> {
  try {
    for (const chat of await getDoctorRecipients(env)) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
      });
    }
  } catch (e) {
    console.log("[espejo] notificarDoctores falló:", (e as Error).message);
  }
}

async function alertarTope(
  env: Env,
  cancelaciones: { etiqueta: string }[],
  origen: OpcionesEspejo["origen"],
): Promise<void> {
  // Desde Telegram el propio comando responde con el resumen: no duplicar.
  if (origen === "manual") return;
  try {
    if (await env.STATE.get(KV_ALERTA_TOPE)) return;
    await env.STATE.put(KV_ALERTA_TOPE, "1", { expirationTtl: ALERTA_TTL_S });
  } catch { /* si KV falla, mejor avisar de más que de menos */ }
  const lista = cancelaciones
    .slice(0, 8)
    .map((c) => `• ${escapeHtml(c.etiqueta)}`)
    .join("\n");
  await notificarDoctores(
    env,
    `⛔ <b>Espejo Bukeala → Calendar detenido</b>\n` +
      `Iba a cancelar <b>${cancelaciones.length}</b> eventos (tope: ${TOPE_CANCELACIONES}). ` +
      `Puede ser que Bukeala devolvió la agenda incompleta. <b>No se tocó nada.</b>\n\n${lista}` +
      `${cancelaciones.length > 8 ? "\n…" : ""}\n\n` +
      `Si las cancelaciones son reales: <code>/espejo_calendar forzar</code>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Resumen en HTML de Telegram. Lo usan el comando y la alerta. */
export function formatearResumenEspejo(r: ResumenEspejo): string {
  const l: string[] = ["🪞 <b>Espejo Bukeala → Google Calendar</b>"];
  l.push(
    `Ventana: ${r.ventana.desde} → ${r.ventana.hasta} (${r.ventana.dias} días) · ` +
      `Bukeala: ${r.citasActivas} activas / ${r.citasCanceladasEnBukeala} canceladas en ${r.diasLeidos} día(s) leído(s)`,
  );
  if (r.abortado) {
    l.push(`⛔ <b>Abortado, nada se tocó</b>: ${escapeHtml(r.motivo ?? "sin motivo")}`);
  } else {
    l.push(
      `✅ Creados: ${r.creados} · ✏️ Actualizados: ${r.actualizados} · ♻️ Restaurados: ${r.restaurados} · ➖ Sin cambios: ${r.sinCambios}`,
    );
    l.push(`🚫 Cancelados: ${r.cancelados}`);
  }
  if (r.diasFallidos.length) {
    l.push(
      `⚠️ Días NO leídos (sin cancelaciones ahí): ${r.diasFallidos
        .slice(0, 5)
        .map((d) => `${d.fecha} (${escapeHtml(d.motivo)})`)
        .join(", ")}${r.diasFallidos.length > 5 ? "…" : ""}`,
    );
  }
  if (r.errores.length) {
    l.push(`❌ Errores: ${r.errores.length} — ${escapeHtml(r.errores.slice(0, 3).join(" | "))}`);
  }
  l.push(`⏱ ${(r.duracionMs / 1000).toFixed(1)} s`);
  return l.join("\n");
}

/** Última corrida guardada (para `/espejo_calendar estado`). */
export async function ultimaCorridaEspejo(env: Env): Promise<ResumenEspejo | null> {
  try {
    const raw = await env.STATE.get(KV_ULTIMA);
    return raw ? (JSON.parse(raw) as ResumenEspejo) : null;
  } catch {
    return null;
  }
}
