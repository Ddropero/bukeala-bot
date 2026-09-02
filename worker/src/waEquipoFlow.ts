/**
 * Flujo de WhatsApp para el EQUIPO del consultorio (Laura, la asistente, y el
 * Dr.): registrar citas en Google Calendar escribiendo como se habla.
 *
 * POR QUÉ EXISTE
 * El WhatsApp del consultorio lo atiende la IA de pacientes (runBookingAgent).
 * Hasta ahora el webhook no distinguía números: si Laura escribía "agenda a
 * María Pérez el 5 a las 8", la IA le contestaba como si fuera una paciente
 * pidiendo cita y su mensaje quedaba en el historial de pacientes. Este módulo
 * es el desvío: el webhook manda aquí a los números del equipo ANTES de
 * cualquier lógica de paciente (ver handlers/whatsappWebhook.ts).
 *
 * QUÉ HACE
 *   1. Captura híbrida: Claude extrae los 6 datos (nombre, cédula, aseguradora,
 *      teléfono, email, fecha/hora) del texto libre; lo que falte se pregunta
 *      campo por campo, en ese orden. Si Claude no responde, se cae a parsers
 *      locales y a preguntar campo por campo — el flujo nunca se bloquea por
 *      la API.
 *   2. Resumen + confirmación con botones. Nada se escribe sin el ✅ de Laura.
 *   3. Al confirmar: evento en Google Calendar (el calendario del Dr., que
 *      desde ago-2026 es la agenda completa: espejo de Bukeala + particular),
 *      contacto al directorio propio, aviso al Dr. por Telegram y, solo si
 *      Laura lo pide con un botón, confirmación al paciente por WhatsApp.
 *   4. Atajos: "hoy", "mañana", "agenda DD/MM" mandan la agenda del día.
 *
 * LO QUE NO ES
 * Los eventos que crea NO son del espejo Bukeala → Calendar. Llevan
 * `origen: "secretaria"` en extendedProperties.private y NUNCA `bukealaId` /
 * `bukealaHash` / `bukealaFecha` / `origen: "bukeala"`: cron/espejoCalendar.ts
 * lista sus eventos por esas propiedades y cancelaría uno que no encuentre en
 * Bukeala. Con otro origen, el espejo ni los ve.
 *
 * ESTADO
 *   wa:equipo:{from}        → { paso, datos, at, evento? }  TTL 30 min
 *   wa:equipo:seen:{msgId}  → "1"                            TTL 10 min
 * El segundo evita registrar dos veces si Meta reentrega el mismo webhook.
 */
import type { Env } from "./env";
import {
  sendText,
  sendInteractiveButtons,
  normalizeColombianPhone,
  sendAppointmentConfirmRequest,
} from "./whatsapp";
import { createEvent, deleteEvent, listEventsFiltrado, type GCalEvent } from "./gcal";
import { guardarContacto } from "./pacientesContacto";
import { getDoctorRecipients } from "./users";

// ————————————————————————— constantes —————————————————————————

const TZ = "America/Bogota";
/** Bogotá es UTC-5 todo el año (sin horario de verano). */
const OFFSET_BOGOTA_MS = -5 * 3600 * 1000;
const TTL_ESTADO_S = 30 * 60;
const TTL_VISTO_S = 10 * 60;
const DURACION_DEFAULT_MIN = 20;
/** Fuera de este rango se pide confirmar la hora antes de crear. */
const HORA_MIN = 6;
const HORA_MAX = 20;
const CONSULTORIO = "Calle 80 # 10-43, Cons 506";
/**
 * Color distinto al del espejo (sage, "2") para que el Dr. vea de un vistazo
 * qué citas registró Laura a mano — esas NO están en Bukeala todavía.
 */
const COLOR_ID = "7";
const ORIGEN = "secretaria";
/** Mismo modelo y misma API key que el agente de pacientes (claudeBookingAgent). */
const MODELO = "claude-sonnet-4-6";
const PREFIJO_BOTON = "eq:";

const kvEstado = (from: string) => `wa:equipo:${from}`;
const kvVisto = (id: string) => `wa:equipo:seen:${id}`;

// ————————————————————————— tipos —————————————————————————

/** Lo que este flujo lee del mensaje entrante de Meta (subconjunto del webhook). */
export interface MensajeWaEntrante {
  id?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
}

export interface DatosCita {
  nombre?: string;
  /** Solo dígitos. */
  cedula?: string;
  aseguradora?: string;
  /** 57XXXXXXXXXX (E.164 sin "+"). */
  telefono?: string;
  /** Laura dijo explícitamente que no hay número. */
  sinTelefono?: boolean;
  email?: string;
  /** Laura dijo explícitamente que no hay correo. */
  sinEmail?: boolean;
  /** ISO con offset -05:00. */
  fechaHora?: string;
  duracionMin?: number;
  /** Motivo/tipo si lo dijo: "cirugía", "control", "valoración"… */
  nota?: string;
  /** Laura confirmó una hora fuera de 6:00–20:00. */
  horaConfirmada?: boolean;
}

type Paso =
  | "nombre"
  | "cedula"
  | "aseguradora"
  | "aseguradora_otra"
  | "telefono"
  | "email"
  | "fechaHora"
  | "hora_rara"
  | "confirmar"
  | "corregir"
  | "creando"
  | "avisar";

interface EstadoEquipo {
  paso: Paso;
  datos: DatosCita;
  at: number;
  /** Tras crear: lo necesario para el botón "Avisarle al paciente". */
  evento?: { id: string; htmlLink?: string };
}

// ————————————————————————— utilidades de fecha (Bogotá) —————————————————————————

const pad2 = (n: number) => String(n).padStart(2, "0");
const DIAS_ES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Instante real → Date cuyos campos UTC leen como hora local de Bogotá. */
function aBogota(d: Date): Date {
  return new Date(d.getTime() + OFFSET_BOGOTA_MS);
}

/** Instante real → "2026-09-05T08:00:00-05:00". */
function isoBogota(d: Date): string {
  const b = aBogota(d);
  return (
    `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}` +
    `T${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}:00-05:00`
  );
}

/** "Viernes 5 de septiembre" (+ " de 2027" si no es el año en curso). */
function fechaLegibleLarga(d: Date): string {
  const b = aBogota(d);
  const anioActual = aBogota(new Date()).getUTCFullYear();
  const base = `${DIAS_ES[b.getUTCDay()]} ${b.getUTCDate()} de ${MESES_ES[b.getUTCMonth()]}`;
  return b.getUTCFullYear() === anioActual ? base : `${base} de ${b.getUTCFullYear()}`;
}

/** "Viernes 05/09/26" — el formato que ya usan los recordatorios al paciente. */
function fechaCorta(d: Date): string {
  const b = aBogota(d);
  return `${DIAS_ES[b.getUTCDay()]} ${pad2(b.getUTCDate())}/${pad2(b.getUTCMonth() + 1)}/${String(b.getUTCFullYear()).slice(2)}`;
}

/** "08:00 AM" — mismo formato que la agenda (fechaAHora12 en fuentes/tipos.ts). */
function hora12(d: Date): string {
  const b = aBogota(d);
  let h = b.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${pad2(h)}:${pad2(b.getUTCMinutes())} ${ampm}`;
}

/** "DD-MM-YYYY" del día (Bogotá) de un instante, para secretaryAgendaCron. */
function fechaDashed(d: Date): string {
  const b = aBogota(d);
  return `${pad2(b.getUTCDate())}-${pad2(b.getUTCMonth() + 1)}-${b.getUTCFullYear()}`;
}

function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function telLegible(tel?: string): string {
  const d = (tel ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("57")) return `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return d ? `+${d}` : "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ————————————————————————— quién escribe —————————————————————————

function coincideNumero(a: string, b: string): boolean {
  const x = a.replace(/\D/g, "");
  const y = b.replace(/\D/g, "");
  if (x.length < 10 || y.length < 10) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

/**
 * "Laura" si es el primer número de SECRETARY_WHATSAPP_NUMBERS, "Dr. David"
 * si es DOCTOR_WHATSAPP_NUMBER; si no, el número tal cual. Va en la
 * descripción del evento y en el aviso por Telegram.
 */
export function nombreDeQuienEscribe(env: Env, from: string): string {
  const secretarias = String(env.SECRETARY_WHATSAPP_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secretarias[0] && coincideNumero(secretarias[0], from)) return "Laura";
  if (env.DOCTOR_WHATSAPP_NUMBER && coincideNumero(env.DOCTOR_WHATSAPP_NUMBER, from)) return "Dr. David";
  return from;
}

// ————————————————————————— estado en KV —————————————————————————

async function leerEstado(env: Env, from: string): Promise<EstadoEquipo | null> {
  try {
    const raw = await env.STATE.get(kvEstado(from));
    if (!raw) return null;
    const e = JSON.parse(raw) as EstadoEquipo;
    return e && typeof e.paso === "string" && e.datos ? e : null;
  } catch {
    return null;
  }
}

async function guardarEstado(env: Env, from: string, paso: Paso, datos: DatosCita, evento?: EstadoEquipo["evento"]): Promise<void> {
  const e: EstadoEquipo = { paso, datos, at: Date.now(), ...(evento ? { evento } : {}) };
  await env.STATE.put(kvEstado(from), JSON.stringify(e), { expirationTtl: TTL_ESTADO_S });
}

async function borrarEstado(env: Env, from: string): Promise<void> {
  try { await env.STATE.delete(kvEstado(from)); } catch { /* ya no está */ }
}

// ————————————————————————— extracción con Claude —————————————————————————

/** Campos que Claude devuelve; todos opcionales, solo se mezclan los presentes. */
type Extraccion = Pick<
  DatosCita,
  "nombre" | "cedula" | "aseguradora" | "telefono" | "sinTelefono" | "email" | "sinEmail" | "fechaHora" | "duracionMin" | "nota"
>;

function promptSistema(): string {
  const ahora = new Date();
  const b = aBogota(ahora);
  const ahoraTexto = `${DIAS_ES[b.getUTCDay()]} ${b.getUTCDate()} de ${MESES_ES[b.getUTCMonth()]} de ${b.getUTCFullYear()}, ${hora12(ahora)}`;
  return `Eres el extractor de datos del consultorio del Dr. David Duque (cirujano plástico, Bogotá). La asistente escribe por WhatsApp, como habla, para registrar una cita. Tu única tarea es sacar los datos y devolver JSON. No conversas.

AHORA en Bogotá: ${ahoraTexto} (zona horaria America/Bogota, UTC-5, sin horario de verano).

Devuelve SOLO un objeto JSON, sin texto alrededor y sin \`\`\`, con estas claves (null cuando el dato no aparece):
{
  "nombre": string|null,       // nombre completo del PACIENTE con Mayúscula Inicial. Nunca el de la asistente ni el del doctor.
  "cedula": string|null,       // solo dígitos, sin puntos ni espacios
  "aseguradora": string|null,  // "Colsanitas", "Particular" o el nombre que diga (Sura, Sanitas, Compensar, Medplus, Coomeva, Famisanar...). "particular", "privado", "paga él" → "Particular"
  "telefono": string|null,     // solo dígitos, tal como aparecen (celular colombiano de 10 dígitos, con o sin 57)
  "sinTelefono": boolean,      // true SOLO si dice explícitamente que no hay número
  "email": string|null,        // correo del paciente
  "sinEmail": boolean,         // true SOLO si dice explícitamente que no tiene correo
  "fechaHora": string|null,    // ISO 8601 con offset -05:00, ej "2026-09-05T08:00:00-05:00"
  "duracionMin": number|null,  // solo si dice cuánto dura: "1 hora" → 60, "2h" → 120, "media hora" → 30. Si dice que es cirugía y no dice cuánto, 120.
  "nota": string|null          // motivo o tipo si lo dice: "cirugía", "control", "valoración", "retiro de puntos"... (máx. 6 palabras)
}

REGLAS DE FECHA Y HORA (lo más delicado):
- Todo en hora de Bogotá.
- "hoy", "mañana", "pasado mañana" se cuentan desde AHORA.
- Un día de la semana ("el jueves") es la PRÓXIMA ocurrencia; si es hoy y la hora ya pasó, la de la semana siguiente.
- "5/9", "5-9", "05/09" son DÍA/MES (formato colombiano), nunca mes/día.
- Sin año: el año en curso; si así la fecha quedó más de 7 días en el pasado, el año siguiente.
- Hora sin AM/PM: 6 a 11 → mañana; 12 → mediodía; 1 a 5 → tarde (13:00 a 17:00). "8 y media" → 08:30. "a las 8" → 08:00.
- Si dice fecha pero no hora, o hora pero no fecha, deja fechaHora en null. No inventes.
- Si te dan "datos ya conocidos" y el mensaje corrige solo la fecha, conserva la hora conocida (y al revés).

Nunca inventes un dato. Si dudas, null.`;
}

/**
 * Llama a Claude y devuelve los campos que encontró. `null` si la API falló o
 * no devolvió JSON — el llamador cae a los parsers locales / preguntar.
 *
 * `conocidos` (corrección o respuesta a una pregunta) le da contexto para que
 * devuelva solo lo que cambia; `pidiendo` le dice qué campo se le acaba de
 * preguntar a Laura, así "3001234567" no se confunde con una cédula.
 */
export async function extraerDatosCita(
  env: Env,
  texto: string,
  opts: { conocidos?: DatosCita; pidiendo?: Paso } = {},
): Promise<Extraccion | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const partes: string[] = [];
  if (opts.conocidos && Object.keys(opts.conocidos).length) {
    partes.push(
      "Datos ya conocidos (devuelve SOLO lo que este mensaje agregue o corrija; lo demás null):\n" +
        JSON.stringify(datosPublicos(opts.conocidos)),
    );
  }
  if (opts.pidiendo) {
    const etiqueta: Partial<Record<Paso, string>> = {
      nombre: "el nombre del paciente",
      cedula: "la cédula",
      aseguradora: "la aseguradora",
      aseguradora_otra: "la aseguradora",
      telefono: "el celular",
      email: "el correo",
      fechaHora: "la fecha y hora",
      hora_rara: "la fecha y hora",
      corregir: "qué dato quiere corregir",
    };
    if (etiqueta[opts.pidiendo]) partes.push(`Se le acaba de preguntar por: ${etiqueta[opts.pidiendo]}.`);
  }
  partes.push(`Mensaje de la asistente:\n"""${texto.slice(0, 1500)}"""`);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 400,
        temperature: 0,
        system: promptSistema(),
        messages: [{ role: "user", content: partes.join("\n\n") }],
      }),
    });
    if (!res.ok) {
      console.log(`[wa-equipo] claude ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = await res.json<any>();
    const salida = (data?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => String(b.text ?? ""))
      .join("\n");
    const obj = parsearJsonTolerante(salida);
    if (!obj) {
      console.log("[wa-equipo] claude sin JSON:", salida.slice(0, 200));
      return null;
    }
    return normalizarExtraccion(obj);
  } catch (e) {
    console.log("[wa-equipo] claude falló:", (e as Error).message);
    return null;
  }
}

/** Lo que se le muestra a Claude como "conocido" (sin banderas internas). */
function datosPublicos(d: DatosCita): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["nombre", "cedula", "aseguradora", "telefono", "email", "fechaHora", "duracionMin", "nota"] as const) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  if (d.sinEmail) out.sinEmail = true;
  if (d.sinTelefono) out.sinTelefono = true;
  return out;
}

/** Saca el primer objeto JSON de una respuesta, aunque venga con ``` o texto alrededor. */
function parsearJsonTolerante(s: string): any | null {
  const limpio = s.replace(/```(?:json)?/gi, "").trim();
  const a = limpio.indexOf("{");
  const b = limpio.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(limpio.slice(a, b + 1));
  } catch {
    return null;
  }
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function telefonoValido(raw?: string): string {
  const n = normalizeColombianPhone(raw ?? "");
  return n.length === 12 && n.startsWith("57") ? n : "";
}

function cedulaValida(raw?: string): string {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 5 && d.length <= 12 ? d : "";
}

function normalizarAseguradora(raw: string): string {
  const t = sinAcentos(raw.trim().toLowerCase());
  if (/colsanitas/.test(t)) return "Colsanitas";
  if (/\b(particular|privad[ao]|sin (seguro|eps))\b/.test(t)) return "Particular";
  // Mayúscula inicial por palabra, respetando siglas cortas (EPS, SOS...).
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ")
    .slice(0, 40);
}

/** ISO cualquiera → ISO Bogotá. Sin offset se asume Bogotá (no UTC del runtime). */
function normalizarIso(raw: string): string {
  let s = raw.trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s = `${s}-05:00`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : isoBogota(d);
}

/** Valida tipo por tipo lo que devolvió Claude; lo que no cuadra se descarta. */
function normalizarExtraccion(raw: any): Extraccion {
  const out: Extraccion = {};
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const nombre = str(raw.nombre);
  if (nombre.length >= 2) out.nombre = nombre.slice(0, 80);
  const ced = cedulaValida(str(raw.cedula));
  if (ced) out.cedula = ced;
  const aseg = str(raw.aseguradora);
  if (aseg) out.aseguradora = normalizarAseguradora(aseg);
  const tel = telefonoValido(str(raw.telefono));
  if (tel) out.telefono = tel;
  if (raw.sinTelefono === true && !tel) out.sinTelefono = true;
  const email = str(raw.email).toLowerCase();
  if (RE_EMAIL.test(email)) out.email = email;
  if (raw.sinEmail === true && !email) out.sinEmail = true;
  const fh = str(raw.fechaHora);
  if (fh) {
    const iso = normalizarIso(fh);
    if (iso) out.fechaHora = iso;
  }
  const dur = Number(raw.duracionMin);
  if (Number.isFinite(dur) && dur >= 10 && dur <= 600) out.duracionMin = Math.round(dur);
  const nota = str(raw.nota);
  if (nota) out.nota = nota.slice(0, 80);
  return out;
}

// ————————————————————————— parsers locales (respaldo sin Claude) —————————————————————————

const DIAS_LOCAL = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MESES_LOCAL: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7,
  septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, sept: 8, oct: 9, nov: 10, dic: 11,
};

/**
 * Fecha + hora sin IA, para cuando Claude no responde. Cubre lo que Laura
 * escribe de verdad: "mañana 10:30", "el jueves a las 3pm", "5/9 8:00",
 * "5 de septiembre a las 8". Si falta la fecha o la hora devuelve null: es
 * mejor volver a preguntar que inventar.
 */
export function parsearFechaHoraLocal(texto: string): string | null {
  const t = sinAcentos(texto.toLowerCase());
  // "8 de la mañana" es una HORA, no el día de mañana: se quita antes de
  // buscar la fecha (para la hora se usa `resto`, que sí lo conserva).
  const tFecha = t.replace(/\b(de|en|por)\s+la\s+manana\b/g, " ");
  const hoy = aBogota(new Date());
  let y = hoy.getUTCFullYear();
  let m = hoy.getUTCMonth();
  let d = hoy.getUTCDate();
  let fechaOk = false;
  /** Solo cuenta el año escrito EN la fecha: una cédula o un celular también tienen 4 dígitos seguidos. */
  let anioExplicito = false;
  let resto = t;
  let mm: RegExpMatchArray | null;

  if (/\bpasado\s*manana\b/.test(tFecha)) {
    d += 2; fechaOk = true;
  } else if (/\bmanana\b/.test(tFecha)) {
    d += 1; fechaOk = true;
  } else if (/\bhoy\b/.test(tFecha)) {
    fechaOk = true;
  } else if ((mm = tFecha.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/))) {
    d = +mm[1]; m = +mm[2] - 1;
    if (mm[3]) { y = mm[3].length === 2 ? 2000 + +mm[3] : +mm[3]; anioExplicito = true; }
    fechaOk = d >= 1 && d <= 31 && m >= 0 && m <= 11;
    resto = t.replace(mm[0], " ");
  } else {
    // "5 de septiembre", "5 sept 2026": el primer "número + palabra" que sea un mes.
    for (const mes of tFecha.matchAll(/\b(\d{1,2})\s*(?:de\s+)?([a-z]{3,10})\b(?:\s*(?:de\s+)?(\d{4}))?/g)) {
      if (MESES_LOCAL[mes[2]] === undefined) continue;
      d = +mes[1]; m = MESES_LOCAL[mes[2]];
      if (mes[3]) { y = +mes[3]; anioExplicito = true; }
      fechaOk = d >= 1 && d <= 31;
      resto = t.replace(mes[0], " ");
      break;
    }
    if (!fechaOk) {
      for (let i = 0; i < DIAS_LOCAL.length; i++) {
        if (new RegExp(`\\b${DIAS_LOCAL[i]}\\b`).test(tFecha)) {
          let delta = (i - hoy.getUTCDay() + 7) % 7;
          if (delta === 0) delta = 7; // "el jueves" un jueves = el de la semana que viene
          d += delta; fechaOk = true;
          break;
        }
      }
    }
  }
  if (!fechaOk) return null;

  // Hora: solo se acepta si viene con "a las", con ":MM", o con am/pm/tarde…
  // Un número suelto puede ser parte de la cédula o del teléfono.
  const hm = resto.match(
    /(?:\ba\s+las?\s+|\blas?\s+)(\d{1,2})(?:[:.h](\d{2}))?(?:\s*y\s*(media|cuarto))?\s*(am|pm|a\.?\s?m\.?|p\.?\s?m\.?|de la manana|de la tarde|de la noche|del mediodia|mediodia)?\b/,
  ) ?? resto.match(
    /\b(\d{1,2})(?::(\d{2}))?()\s*(am|pm|a\.?\s?m\.?|p\.?\s?m\.?|de la manana|de la tarde|de la noche)\b/,
  ) ?? resto.match(/\b(\d{1,2}):(\d{2})()()\b/);
  if (!hm) return null;
  let h = +hm[1];
  let min = hm[2] ? +hm[2] : 0;
  if (hm[3] === "media") min = 30;
  if (hm[3] === "cuarto") min = 15;
  const suf = (hm[4] ?? "").replace(/[\s.]/g, "");
  if (h > 23 || min > 59) return null;
  if (/^pm|tarde|noche/.test(suf)) { if (h < 12) h += 12; }
  else if (/^am|manana/.test(suf)) { if (h === 12) h = 0; }
  else if (/mediodia/.test(suf)) { h = 12; }
  else if (h >= 1 && h <= 5) h += 12; // "a las 3" → 15:00
  // Sin año explícito y fecha ya pasada hace más de una semana → año siguiente.
  let instante = Date.UTC(y, m, d, h + 5, min);
  if (!anioExplicito && instante < Date.now() - 7 * 86400000) instante = Date.UTC(y + 1, m, d, h + 5, min);
  return isoBogota(new Date(instante));
}

/** Respuesta directa a la pregunta de un campo. null = no se entendió. */
function parsearCampoDirecto(paso: Paso, texto: string): Partial<DatosCita> | null {
  const t = texto.trim();
  const tl = sinAcentos(t.toLowerCase());
  const diceNo = /^(no|no tiene|no hay|sin|ninguno|ninguna|no se|nada)\b/.test(tl) && tl.length < 25;
  switch (paso) {
    case "nombre": {
      // Solo letras/espacios y de 2 a 6 palabras: un nombre, no una frase.
      if (/^[a-záéíóúñü'.\s-]{2,80}$/i.test(t) && t.split(/\s+/).length <= 6 && !/\b(agenda|cita|para|el|la)\b/i.test(t)) {
        return { nombre: t.replace(/\s+/g, " ") };
      }
      return null;
    }
    case "cedula": {
      const ced = cedulaValida(t);
      return ced && /^[\d.\s-]+$/.test(t.replace(/^(cc|c\.c\.|cedula)\s*/i, "")) ? { cedula: ced } : null;
    }
    case "aseguradora":
    case "aseguradora_otra":
      return /^[a-záéíóúñü\s.&-]{3,40}$/i.test(t) ? { aseguradora: normalizarAseguradora(t) } : null;
    case "telefono": {
      if (diceNo) return { sinTelefono: true };
      const tel = telefonoValido(t);
      return tel && /^[\d+.\s()-]+$/.test(t) ? { telefono: tel } : null;
    }
    case "email": {
      if (diceNo) return { sinEmail: true };
      const e = t.toLowerCase();
      return RE_EMAIL.test(e) ? { email: e } : null;
    }
    case "fechaHora":
    case "hora_rara": {
      const iso = parsearFechaHoraLocal(t);
      return iso ? { fechaHora: iso } : null;
    }
    default:
      return null;
  }
}

/** Respaldo para el primer mensaje cuando Claude no responde: regexes sueltos. */
function extraerLocal(texto: string): Partial<DatosCita> {
  const out: Partial<DatosCita> = {};
  const email = texto.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
  if (email && RE_EMAIL.test(email[0].toLowerCase())) out.email = email[0].toLowerCase();
  const cc = texto.match(/\b(?:cc|c\.c\.|cedula|cédula)\s*:?\s*([\d.]{5,15})/i);
  if (cc) { const c = cedulaValida(cc[1]); if (c) out.cedula = c; }
  const tel = texto.match(/(?:\+?57)?\s*(3\d{2}[\s.-]?\d{3}[\s.-]?\d{4})(?!\d)/);
  if (tel) { const n = telefonoValido(tel[1]); if (n) out.telefono = n; }
  if (/colsanitas/i.test(texto)) out.aseguradora = "Colsanitas";
  else if (/particular/i.test(texto)) out.aseguradora = "Particular";
  const fh = parsearFechaHoraLocal(texto);
  if (fh) out.fechaHora = fh;
  return out;
}

// ————————————————————————— máquina de estados —————————————————————————

function mezclar(base: DatosCita, nuevo: Partial<DatosCita>): DatosCita {
  const out: DatosCita = { ...base };
  for (const [k, v] of Object.entries(nuevo)) {
    if (v === undefined || v === null || v === "") continue;
    (out as any)[k] = v;
  }
  if (nuevo.email) out.sinEmail = false;
  if (nuevo.telefono) out.sinTelefono = false;
  // Una fecha nueva vuelve a pasar por el chequeo de hora rara.
  if (nuevo.fechaHora && nuevo.fechaHora !== base.fechaHora) out.horaConfirmada = false;
  return out;
}

/** El primer campo que falta, en el orden en que se pregunta. */
function campoFaltante(d: DatosCita): Paso | null {
  if (!d.nombre) return "nombre";
  if (!d.cedula) return "cedula";
  if (!d.aseguradora) return "aseguradora";
  if (!d.telefono && !d.sinTelefono) return "telefono";
  if (!d.email && !d.sinEmail) return "email";
  if (!d.fechaHora) return "fechaHora";
  return null;
}

async function preguntar(env: Env, from: string, paso: Paso, d: DatosCita): Promise<void> {
  const quien = d.nombre ? d.nombre.split(" ")[0] : "el paciente";
  switch (paso) {
    case "nombre":
      await sendText(env, from, "¿Cómo se llama el paciente? (nombre completo)");
      return;
    case "cedula":
      await sendText(env, from, `¿Número de cédula de ${quien}?`);
      return;
    case "aseguradora":
      await sendInteractiveButtons(env, from, `¿Con qué aseguradora viene ${quien}?`, [
        { id: `${PREFIJO_BOTON}aseg:colsanitas`, title: "Colsanitas" },
        { id: `${PREFIJO_BOTON}aseg:particular`, title: "Particular" },
        { id: `${PREFIJO_BOTON}aseg:otra`, title: "Otra" },
      ]);
      return;
    case "aseguradora_otra":
      await sendText(env, from, "¿Cuál aseguradora? Escríbeme el nombre.");
      return;
    case "telefono":
      await sendText(env, from, `¿Celular de ${quien}? (responde *no* si no tiene)`);
      return;
    case "email":
      await sendText(env, from, `¿Correo de ${quien}? Escríbelo o responde *no* si no tiene.`);
      return;
    case "fechaHora":
      await sendText(
        env,
        from,
        "¿Para qué día y hora? Por ejemplo: *5 de septiembre a las 8*, *mañana 10:30* o *jueves 3pm*.",
      );
      return;
    default:
      return;
  }
}

function textoResumen(d: DatosCita): string {
  const f = new Date(d.fechaHora!);
  const l = ["📋 Revisa los datos:", ""];
  l.push(`👤 *${d.nombre}*`);
  l.push(`🪪 CC ${d.cedula}`);
  l.push(`🏥 ${d.aseguradora}`);
  l.push(d.telefono ? `📞 ${telLegible(d.telefono)}` : "📞 sin teléfono");
  l.push(d.email ? `✉️ ${d.email}` : "✉️ sin correo");
  l.push(`📅 ${fechaLegibleLarga(f)} · ${hora12(f)} (${d.duracionMin ?? DURACION_DEFAULT_MIN} min)`);
  if (d.nota) l.push(`📝 ${d.nota}`);
  l.push("", "¿La agendo?");
  return l.join("\n");
}

/**
 * Con lo que hay, decide el siguiente paso: preguntar lo que falta, pedir
 * corrección si la fecha ya pasó, confirmar una hora rara, o mostrar el
 * resumen. Es el único sitio que avanza el flujo, así el orden de preguntas
 * vive en un solo lugar.
 */
async function avanzar(env: Env, from: string, datos: DatosCita): Promise<void> {
  const falta = campoFaltante(datos);
  if (falta) {
    await guardarEstado(env, from, falta, datos);
    await preguntar(env, from, falta, datos);
    return;
  }
  const inicio = new Date(datos.fechaHora!);
  if (inicio.getTime() < Date.now() - 5 * 60 * 1000) {
    const sinFecha: DatosCita = { ...datos };
    delete sinFecha.fechaHora;
    await guardarEstado(env, from, "fechaHora", sinFecha);
    await sendText(
      env,
      from,
      `⚠️ Esa fecha ya pasó (${fechaLegibleLarga(inicio)} ${hora12(inicio)}). ¿Para qué día y hora es la cita?`,
    );
    return;
  }
  const b = aBogota(inicio);
  const minutosDia = b.getUTCHours() * 60 + b.getUTCMinutes();
  if ((minutosDia < HORA_MIN * 60 || minutosDia > HORA_MAX * 60) && !datos.horaConfirmada) {
    await guardarEstado(env, from, "hora_rara", datos);
    await sendInteractiveButtons(
      env,
      from,
      `🕐 La hora quedó a las *${hora12(inicio)}* del ${fechaLegibleLarga(inicio)}, fuera del horario habitual. ¿Es correcta?`,
      [
        { id: `${PREFIJO_BOTON}hora_ok`, title: "✅ Sí, a esa hora" },
        { id: `${PREFIJO_BOTON}hora_fix`, title: "✏️ Cambiar hora" },
      ],
    );
    return;
  }
  await guardarEstado(env, from, "confirmar", datos);
  await sendInteractiveButtons(env, from, textoResumen(datos), [
    { id: `${PREFIJO_BOTON}ok`, title: "✅ Agendar" },
    { id: `${PREFIJO_BOTON}fix`, title: "✏️ Corregir" },
    { id: `${PREFIJO_BOTON}cancel`, title: "❌ Cancelar" },
  ]);
}

// ————————————————————————— crear en Calendar —————————————————————————

/**
 * Cuerpo del evento. La descripción va en el formato que ya leen
 * fuentes/gcal.ts (📞 / 🪪 / ✉️ por emoji) y la agenda de Laura; el título
 * "Nombre - Aseguradora" porque ese parser toma como paciente lo que va antes
 * de " - ". Ver el encabezado del archivo sobre por qué NUNCA lleva bukealaId.
 */
export function construirEventoCalendar(d: DatosCita, from: string, quien: string): GCalEvent {
  const inicio = new Date(d.fechaHora!);
  const fin = new Date(inicio.getTime() + (d.duracionMin ?? DURACION_DEFAULT_MIN) * 60000);
  const lineas = [`🪪 CC ${d.cedula}`, `🏥 ${d.aseguradora}`];
  if (d.telefono) lineas.push(`📞 +${d.telefono}`);
  if (d.email) lineas.push(`✉️ ${d.email}`);
  if (d.nota) lineas.push(`📝 ${d.nota}`);
  lineas.push(`📝 Registrada por ${quien} por WhatsApp`);
  return {
    summary: `${d.nombre} - ${d.aseguradora}`,
    description: lineas.join("\n"),
    start: { dateTime: isoBogota(inicio), timeZone: TZ },
    end: { dateTime: isoBogota(fin), timeZone: TZ },
    extendedProperties: {
      private: { origen: ORIGEN, registradoPor: from, cedula: d.cedula ?? "" },
    },
    colorId: COLOR_ID,
    // Igual que el espejo: sin alarmas, un día de consultorio son muchas citas.
    reminders: { useDefault: false, overrides: [] },
  };
}

/**
 * ¿Ya existe este mismo registro? Guardia contra el doble ✅ (o un webhook
 * reentregado): misma cédula, mismo inicio, creado por este flujo. Si está,
 * se reutiliza en vez de crear otro.
 */
async function buscarDuplicado(env: Env, d: DatosCita): Promise<GCalEvent | null> {
  try {
    const inicio = new Date(d.fechaHora!);
    const evs = await listEventsFiltrado(env, env.GCAL_CALENDAR_ID!, {
      timeMin: new Date(inicio.getTime() - 3600_000).toISOString(),
      timeMax: new Date(inicio.getTime() + 3600_000).toISOString(),
      privateProps: { origen: ORIGEN, cedula: d.cedula ?? "" },
    });
    return (
      evs.find(
        (ev) =>
          ev.status !== "cancelled" &&
          !!ev.start?.dateTime &&
          new Date(ev.start.dateTime).getTime() === inicio.getTime(),
      ) ?? null
    );
  } catch (e) {
    console.log("[wa-equipo] buscarDuplicado falló (se sigue):", (e as Error).message);
    return null;
  }
}

async function avisarDoctorTelegram(env: Env, texto: string): Promise<void> {
  try {
    const doctores = await getDoctorRecipients(env);
    for (const chat of doctores) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: "HTML", disable_web_page_preview: true }),
      }).catch(() => {});
    }
  } catch (e) {
    console.log("[wa-equipo] aviso telegram falló:", (e as Error).message);
  }
}

async function crearCita(env: Env, from: string, datos: DatosCita): Promise<void> {
  if (!env.GCAL_CALENDAR_ID || !env.GCAL_SERVICE_ACCOUNT_JSON) {
    await sendText(env, from, "❌ El calendario no está configurado en el sistema. Avísale al Dr.");
    return;
  }
  // Candado: un segundo ✅ mientras se crea no debe crear otro evento.
  await guardarEstado(env, from, "creando", datos);
  const quien = nombreDeQuienEscribe(env, from);
  const inicio = new Date(datos.fechaHora!);

  let ev: GCalEvent;
  let reutilizado = false;
  try {
    const dup = await buscarDuplicado(env, datos);
    if (dup) {
      ev = dup;
      reutilizado = true;
    } else {
      ev = await createEvent(env, env.GCAL_CALENDAR_ID, construirEventoCalendar(datos, from, quien));
    }
  } catch (e) {
    console.log("[wa-equipo] createEvent falló:", (e as Error).message);
    await guardarEstado(env, from, "confirmar", datos);
    await sendInteractiveButtons(
      env,
      from,
      `❌ No pude crear la cita en el calendario: ${(e as Error).message.slice(0, 160)}\n\n¿Reintento?`,
      [
        { id: `${PREFIJO_BOTON}ok`, title: "🔁 Reintentar" },
        { id: `${PREFIJO_BOTON}cancel`, title: "❌ Cancelar" },
      ],
    );
    return;
  }
  console.log(`[wa-equipo] ${quien} ${reutilizado ? "reutilizó" : "creó"} evento ${ev.id} (${datos.nombre}, ${datos.fechaHora})`);

  // Directorio propio: es lo que hace que la agenda de Laura traiga el número.
  // guardarContacto ya descarta teléfonos y correos del equipo.
  await guardarContacto(env, {
    cedula: datos.cedula!,
    telefono: datos.telefono,
    email: datos.email,
    nombre: datos.nombre,
    fuente: "manual",
  });

  if (!reutilizado) {
    await avisarDoctorTelegram(
      env,
      `🗓 <b>${escapeHtml(quien)}</b> agendó a <b>${escapeHtml(datos.nombre!)}</b> — ${fechaLegibleLarga(inicio)} ${hora12(inicio)} (${escapeHtml(datos.aseguradora!)})` +
        (ev.htmlLink ? `\n<a href="${ev.htmlLink}">Ver en Calendar</a>` : ""),
    );
  }

  await sendText(
    env,
    from,
    (reutilizado ? "✅ Esa cita ya estaba en el calendario:\n" : "✅ Listo, quedó en el calendario:\n") +
      `*${datos.nombre}* — ${fechaLegibleLarga(inicio)} ${hora12(inicio)}\n` +
      `${datos.aseguradora}${datos.telefono ? ` · 📞 ${telLegible(datos.telefono)}` : ""}`,
  );

  if (datos.telefono) {
    await guardarEstado(env, from, "avisar", datos, { id: ev.id ?? "", htmlLink: ev.htmlLink });
    await sendInteractiveButtons(env, from, "¿Le mando la confirmación al paciente por WhatsApp?", [
      { id: `${PREFIJO_BOTON}avisar`, title: "📲 Sí, avisarle" },
      { id: `${PREFIJO_BOTON}noavisar`, title: "Ahora no" },
    ]);
  } else {
    await borrarEstado(env, from);
  }
}

async function avisarPaciente(env: Env, from: string, datos: DatosCita): Promise<void> {
  const inicio = new Date(datos.fechaHora!);
  const r = await sendAppointmentConfirmRequest(
    env,
    datos.telefono!,
    datos.nombre!,
    fechaCorta(inicio),
    hora12(inicio),
    CONSULTORIO,
  );
  if (r.ok) {
    await sendText(env, from, `📲 Listo, le envié la confirmación a ${datos.nombre!.split(" ")[0]} al ${telLegible(datos.telefono)}.`);
  } else {
    const motivo = (r as any)?.data?.error?.message ?? (r as any)?.reason ?? "Meta no aceptó el envío";
    await sendText(env, from, `⚠️ No pude enviarle el mensaje al paciente (${String(motivo).slice(0, 120)}). Tocará llamarlo.`);
  }
}

// ————————————————————————— atajos: agenda del día —————————————————————————

/**
 * Manda a Laura la agenda de un día reutilizando el cron de la 1 PM en modo
 * prueba (solo a este número, sin Telegram). Ese cron aborta si no hay sesión
 * de Bukeala en KV aunque hoy lea de Calendar; en ese caso se lee Calendar
 * directo aquí para que Laura no se quede sin respuesta.
 */
async function enviarAgendaDelDia(env: Env, from: string, dashed: string): Promise<void> {
  const { secretaryAgendaCron } = await import("./cron/secretaryAgenda");
  const r = await secretaryAgendaCron(env, { testWaOnly: [from], dateDashed: dashed });
  if (r) {
    if (r.waErrors.length) console.log("[wa-equipo] agenda WA con errores:", r.waErrors.join(" | "));
    return;
  }
  const { leerAgendaDelDia } = await import("./agendaFuente");
  const { buildAgendaText } = await import("./agendaDoc");
  const { getContactos } = await import("./pacientesContacto");
  const lectura = await leerAgendaDelDia(env, dashed);
  if (lectura.error) {
    await sendText(env, from, `⚠️ No pude leer la agenda ahora mismo (${lectura.error.slice(0, 120)}). Intenta en unos minutos.`);
    return;
  }
  const dir = await getContactos(env, lectura.bookings.map((b) => b.identification ?? ""));
  const m = dashed.match(/^(\d{2})-(\d{2})-(\d{4})$/)!;
  const dia = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const friendly = `${DIAS_ES[dia.getUTCDay()]} ${m[1]}/${m[2]}/${m[3].slice(2)}`;
  await sendText(env, from, buildAgendaText(lectura.bookings, friendly, dir));
}

/** "hoy" / "mañana" / "agenda 05/09" / "agenda jueves" → DD-MM-YYYY, o null si no es un atajo. */
function fechaDeAtajo(texto: string): string | null {
  const t = sinAcentos(texto.trim().toLowerCase()).replace(/[¿?!¡.]/g, "").trim();
  const hoy = aBogota(new Date());
  const desde = (delta: number) =>
    fechaDashed(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + delta, 12)));
  if (/^(agenda\s+)?(de\s+)?hoy$/.test(t)) return desde(0);
  if (/^(agenda\s+)?(de\s+)?(manana)$/.test(t)) return desde(1);
  if (/^(agenda\s+)?(de\s+)?pasado\s*manana$/.test(t)) return desde(2);
  if (/^agenda$/.test(t)) return desde(1);
  let mm = t.match(/^agenda\s+(?:del?\s+)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (mm) {
    const y = mm[3] ? (mm[3].length === 2 ? 2000 + +mm[3] : +mm[3]) : hoy.getUTCFullYear();
    return fechaDashed(new Date(Date.UTC(y, +mm[2] - 1, +mm[1], 12)));
  }
  mm = t.match(/^agenda\s+(?:del?\s+)?([a-z]+)$/);
  if (mm) {
    const i = DIAS_LOCAL.indexOf(mm[1]);
    if (i >= 0) {
      let delta = (i - hoy.getUTCDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return desde(delta);
    }
  }
  return null;
}

function textoAyuda(quien: string): string {
  return (
    `Hola ${quien} 👋 Esto es lo que sé hacer:\n\n` +
    `📝 *Registrar una cita*: escríbeme los datos como hablas, por ejemplo:\n` +
    `_"Agenda a María Pérez, cc 52.123.456, Colsanitas, 300 123 4567, maria@gmail.com, el 5 de septiembre a las 8"_\n` +
    `Lo que falte te lo pregunto y antes de crearla te muestro el resumen.\n\n` +
    `📅 *Ver la agenda*: escribe *hoy*, *mañana* o *agenda 05/09*.\n\n` +
    `❌ *cancelar*: borra lo que estemos armando.`
  );
}

// ————————————————————————— entrada principal —————————————————————————

/**
 * Punto de entrada desde el webhook. `from` ya es un número del equipo.
 * Devuelve siempre (nunca lanza): un error aquí no debe tumbar el webhook.
 */
export async function flujoEquipo(env: Env, from: string, msg: MensajeWaEntrante, senderName = ""): Promise<void> {
  try {
    await flujoEquipoInterno(env, from, msg, senderName);
  } catch (e) {
    console.log("[wa-equipo] error:", (e as Error).message);
    try {
      await sendText(env, from, "❌ Algo falló procesando tu mensaje. Escribe *cancelar* y vuelve a intentar.");
    } catch { /* nada más que hacer */ }
  }
}

async function flujoEquipoInterno(env: Env, from: string, msg: MensajeWaEntrante, _senderName: string): Promise<void> {
  // Meta reentrega webhooks; un mismo mensaje procesado dos veces podría
  // crear dos citas. El id del mensaje es la llave.
  if (msg.id) {
    if (await env.STATE.get(kvVisto(msg.id))) {
      console.log(`[wa-equipo] mensaje repetido ${msg.id}, ignorado`);
      return;
    }
    await env.STATE.put(kvVisto(msg.id), "1", { expirationTtl: TTL_VISTO_S });
  }

  const quien = nombreDeQuienEscribe(env, from);
  const estado = await leerEstado(env, from);

  // 1) Botones de este flujo (prefijo eq:).
  if (msg.type === "interactive" && msg.interactive?.button_reply) {
    const id = msg.interactive.button_reply.id ?? "";
    if (id.startsWith(PREFIJO_BOTON)) {
      await manejarBoton(env, from, estado, id.slice(PREFIJO_BOTON.length));
    } else {
      await sendText(env, from, "Ese botón no es de este chat. Escribe *ayuda* si necesitas algo.");
    }
    return;
  }

  // 2) Texto (o nota de voz transcrita).
  let texto = "";
  if (msg.type === "text") {
    texto = (msg.text?.body ?? "").trim();
  } else if (msg.type === "audio" && msg.audio?.id) {
    const { downloadWAMedia } = await import("./whatsappMedia");
    const { transcribeAudio } = await import("./whisper");
    const media = await downloadWAMedia(env, msg.audio.id);
    const transcrito = media ? await transcribeAudio(env, media.buffer) : null;
    if (!transcrito) {
      await sendText(env, from, "No pude escuchar la nota de voz. ¿Me lo escribes?");
      return;
    }
    texto = transcrito.trim();
    await sendText(env, from, `🎙️ Entendí: _"${texto.slice(0, 300)}"_`);
  } else {
    await sendText(env, from, "Solo entiendo texto o notas de voz. Escríbeme los datos de la cita o *ayuda*.");
    return;
  }
  if (!texto) return;

  await manejarTexto(env, from, estado, texto, quien);
}

async function manejarBoton(env: Env, from: string, estado: EstadoEquipo | null, accion: string): Promise<void> {
  if (!estado) {
    await sendText(env, from, "Ese botón ya venció (pasaron más de 30 min). Escríbeme la cita de nuevo.");
    return;
  }
  const d = estado.datos;

  if (accion.startsWith("aseg:")) {
    const cual = accion.slice("aseg:".length);
    if (cual === "otra") {
      await guardarEstado(env, from, "aseguradora_otra", d);
      await preguntar(env, from, "aseguradora_otra", d);
      return;
    }
    await avanzar(env, from, mezclar(d, { aseguradora: cual === "colsanitas" ? "Colsanitas" : "Particular" }));
    return;
  }
  switch (accion) {
    case "ok":
      if (estado.paso === "creando") {
        await sendText(env, from, "⏳ Ya la estoy creando, un momento.");
        return;
      }
      if (estado.paso !== "confirmar") {
        const falta = campoFaltante(d);
        if (falta) {
          await sendText(env, from, "Ese botón ya no aplica. Sigamos:");
          await preguntar(env, from, falta, d);
        } else {
          await sendText(env, from, "Ese botón ya no aplica. Escribe *cancelar* para empezar de nuevo.");
        }
        return;
      }
      await crearCita(env, from, d);
      return;
    case "fix":
      await guardarEstado(env, from, "corregir", d);
      await sendText(
        env,
        from,
        "¿Qué dato corrijo? Escríbelo, por ejemplo: *el teléfono es 301 234 5678*, *es el 6 de septiembre a las 9* o *se llama Ana María Ruiz*.",
      );
      return;
    case "cancel":
      await borrarEstado(env, from);
      await sendText(env, from, "Listo, cancelé el registro. No se creó nada.");
      return;
    case "hora_ok":
      await avanzar(env, from, { ...d, horaConfirmada: true });
      return;
    case "hora_fix": {
      const sinFecha: DatosCita = { ...d };
      delete sinFecha.fechaHora;
      await guardarEstado(env, from, "fechaHora", sinFecha);
      await preguntar(env, from, "fechaHora", sinFecha);
      return;
    }
    case "avisar":
      if (estado.paso !== "avisar" || !d.telefono) {
        await sendText(env, from, "Ese botón ya no aplica.");
        return;
      }
      await borrarEstado(env, from);
      await avisarPaciente(env, from, d);
      return;
    case "noavisar":
      await borrarEstado(env, from);
      await sendText(env, from, "Vale, no le aviso. 👌");
      return;
    default:
      await sendText(env, from, "Ese botón ya no está activo.");
  }
}

const RE_SI = /^(s[ií]|ok|okey|okay|dale|listo|claro|agendar|ag[eé]ndala|agenda|confirmo|confirmar|confirmada|correcto|perfecto|va|de una|h[aá]gale|as[ií] es|exacto)\b[\s!.]*$/i;
const RE_NO = /^(no|cancelar|cancela|cancelala|nada|olv[ií]dalo|olvidalo)\b[\s!.]*$/i;
const RE_CORREGIR = /^(corregir|corrige|cambiar|cambia|editar|edita|modificar)\b[\s!.]*$/i;
const RE_CANCELAR = /^(cancelar|cancela|canc[eé]lalo|cancela(r)? (todo|esto|el registro)|olv[ií]dalo|borra(r)? (todo|esto))[\s!.]*$/i;
/** "cancelar la cita de María": eso no se hace por aquí, y no debe abrir un registro. */
const RE_CANCELAR_CITA = /^cancel\w*\s+\S/i;
const RE_AYUDA = /^(ayuda|hola|buenas|buenos d[ií]as|buenas tardes|men[uú]|qu[eé] sabes hacer|help)[\s!.?]*$/i;

async function manejarTexto(env: Env, from: string, estado: EstadoEquipo | null, texto: string, quien: string): Promise<void> {
  const enCurso = estado && estado.paso !== "avisar" ? estado : null;

  if (RE_CANCELAR.test(texto)) {
    await borrarEstado(env, from);
    await sendText(env, from, enCurso ? "Listo, cancelé el registro. No se creó nada." : "No había nada en curso. 👌");
    return;
  }

  if (!enCurso) {
    if (RE_AYUDA.test(texto)) {
      await sendText(env, from, textoAyuda(quien));
      return;
    }
    if (RE_CANCELAR_CITA.test(texto)) {
      await sendText(
        env,
        from,
        "Por aquí solo registro citas nuevas. Para cancelar una cita ya agendada hay que hacerlo en Bukeala o en el calendario del Dr.",
      );
      return;
    }
    const dashed = fechaDeAtajo(texto);
    if (dashed) {
      await enviarAgendaDelDia(env, from, dashed);
      return;
    }
    // "pop cuc" (agenda de cirugías CUC) lo usaba el Dr. desde su propio
    // WhatsApp; como ahora el equipo nunca llega al camino de pacientes, se
    // atiende aquí para no quitárselo.
    {
      const { isPopCucTrigger, handlePopCuc } = await import("./popCuc");
      const userId = `wa:${from}`;
      if (isPopCucTrigger(texto) || (await env.STATE.get(`popcuc:state:${userId}`))) {
        const r = await handlePopCuc(env, userId, texto);
        if (r) {
          await sendText(env, from, r.reply);
          return;
        }
      }
    }
    // Registro nuevo: Claude primero, regexes locales si no responde.
    let ext: Partial<DatosCita> | null = await extraerDatosCita(env, texto);
    const viaClaude = !!ext;
    if (!ext) ext = extraerLocal(texto);
    const datos = mezclar({}, ext);
    if (Object.keys(datos).length === 0) {
      if (texto.split(/\s+/).length <= 3) {
        await sendText(env, from, "No entendí. Para registrar una cita escríbeme los datos del paciente, o *ayuda* para ver qué sé hacer.");
        return;
      }
      if (!viaClaude) {
        await sendText(env, from, "No pude interpretar el mensaje completo; te voy preguntando dato por dato.");
      }
    }
    await avanzar(env, from, datos);
    return;
  }

  const d = enCurso.datos;
  switch (enCurso.paso) {
    case "creando":
      await sendText(env, from, "⏳ Estoy creando la cita, un momento.");
      return;
    case "confirmar": {
      if (RE_SI.test(texto)) { await crearCita(env, from, d); return; }
      if (RE_NO.test(texto)) {
        await borrarEstado(env, from);
        await sendText(env, from, "Listo, cancelé el registro. No se creó nada.");
        return;
      }
      if (RE_CORREGIR.test(texto)) {
        await guardarEstado(env, from, "corregir", d);
        await sendText(env, from, "¿Qué dato corrijo? Escríbelo, por ejemplo: *el teléfono es 301 234 5678*.");
        return;
      }
      // Cualquier otra cosa en el resumen es una corrección directa.
      await corregir(env, from, d, texto);
      return;
    }
    case "corregir":
      await corregir(env, from, d, texto);
      return;
    case "hora_rara": {
      if (RE_SI.test(texto)) { await avanzar(env, from, { ...d, horaConfirmada: true }); return; }
      await responderCampo(env, from, "fechaHora", d, texto);
      return;
    }
    default:
      await responderCampo(env, from, enCurso.paso, d, texto);
  }
}

/** Respuesta a la pregunta de un campo: parser directo → Claude → volver a preguntar. */
async function responderCampo(env: Env, from: string, paso: Paso, d: DatosCita, texto: string): Promise<void> {
  const directo = parsearCampoDirecto(paso, texto);
  if (directo) {
    await avanzar(env, from, mezclar(d, directo));
    return;
  }
  const ext = await extraerDatosCita(env, texto, { conocidos: d, pidiendo: paso });
  if (ext && Object.keys(ext).length) {
    await avanzar(env, from, mezclar(d, ext));
    return;
  }
  const pista: Partial<Record<Paso, string>> = {
    nombre: "No entendí el nombre. Escríbeme solo el nombre completo del paciente.",
    cedula: "No me cuadra esa cédula. Escríbeme solo los números.",
    aseguradora: "No entendí la aseguradora. Escríbeme solo el nombre (p. ej. *Sura*).",
    aseguradora_otra: "No entendí la aseguradora. Escríbeme solo el nombre (p. ej. *Sura*).",
    telefono: "No me cuadra ese celular. Escríbeme los 10 dígitos (o *no* si no tiene).",
    email: "No parece un correo. Escríbelo completo (o *no* si no tiene).",
    fechaHora: "No entendí la fecha y hora. Prueba así: *5 de septiembre a las 8*, *mañana 10:30* o *jueves 3pm*.",
  };
  await sendText(env, from, pista[paso] ?? "No entendí. ¿Me lo repites?");
}

/** Corrección en lenguaje natural sobre el estado ("el teléfono es 301..."). */
async function corregir(env: Env, from: string, d: DatosCita, texto: string): Promise<void> {
  let ext: Partial<DatosCita> | null = await extraerDatosCita(env, texto, { conocidos: d, pidiendo: "corregir" });
  if (!ext || Object.keys(ext).length === 0) {
    // Sin Claude: adivinar el campo por la palabra clave.
    const t = sinAcentos(texto.toLowerCase());
    const valor = texto.replace(/^.*?\b(es|son|seria|sería|:)\s*/i, "").trim();
    if (/tel|cel|numero|whatsapp/.test(t)) ext = parsearCampoDirecto("telefono", valor);
    else if (/cedula|cc\b|documento/.test(t)) ext = parsearCampoDirecto("cedula", valor);
    else if (/correo|email|mail/.test(t)) ext = parsearCampoDirecto("email", valor);
    else if (/nombre|se llama/.test(t)) ext = parsearCampoDirecto("nombre", valor);
    else if (/asegur|eps|plan|prepagada/.test(t)) ext = parsearCampoDirecto("aseguradora", valor);
    else ext = parsearCampoDirecto("fechaHora", texto);
  }
  if (!ext || Object.keys(ext).length === 0) {
    await sendText(env, from, "No entendí qué corregir. Dime el dato y el valor, p. ej. *el correo es ana@gmail.com*.");
    return;
  }
  await avanzar(env, from, mezclar(d, ext));
}

// ————————————————————————— prueba sin tocar el chat —————————————————————————

const TEXTO_EJEMPLO =
  "Agenda a María Pérez, cc 52.123.456, Colsanitas, 300 123 4567, maria@gmail.com, el 5 de septiembre a las 8";

/**
 * GET /debug/equipo-prueba (ver index.ts). Ejercita las piezas sin WhatsApp:
 *   dry=1        extracción con Claude sobre TEXTO_EJEMPLO
 *   crear=1      evento "PRUEBA BORRAR - Particular" mañana 7:00 en el calendario real
 *   borrar=<id>  lo elimina (events.delete)
 * Ni guarda contacto ni avisa al Dr.: es solo para verificar Claude y Calendar.
 */
export async function pruebaEquipo(
  env: Env,
  opts: { dry?: boolean; crear?: boolean; borrar?: string; texto?: string },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ok: true, ahoraBogota: isoBogota(new Date()) };
  if (opts.dry) {
    const texto = opts.texto || TEXTO_EJEMPLO;
    const t0 = Date.now();
    const ext = await extraerDatosCita(env, texto);
    out.texto = texto;
    out.extraido = ext;
    out.claudeMs = Date.now() - t0;
    out.respaldoLocal = extraerLocal(texto);
    out.faltante = ext ? campoFaltante(mezclar({}, ext)) : "(claude no respondió)";
    if (ext && !campoFaltante(mezclar({}, ext))) {
      out.resumen = textoResumen(mezclar({}, ext));
      out.evento = construirEventoCalendar(mezclar({}, ext), "prueba", "Prueba");
    }
    if (!ext) out.ok = false;
  }
  if (opts.crear) {
    if (!env.GCAL_CALENDAR_ID) return { ok: false, error: "GCAL_CALENDAR_ID no configurado" };
    const b = aBogota(new Date());
    const manana7 = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + 1, 7 + 5, 0));
    const datos: DatosCita = {
      nombre: "PRUEBA BORRAR",
      cedula: "999999999",
      aseguradora: "Particular",
      telefono: "573001234567",
      email: "prueba@example.com",
      fechaHora: isoBogota(manana7),
    };
    const cuerpo = construirEventoCalendar(datos, "prueba", "Prueba automática");
    const ev = await createEvent(env, env.GCAL_CALENDAR_ID, cuerpo);
    out.creado = { id: ev.id, htmlLink: ev.htmlLink, summary: ev.summary, start: ev.start, end: ev.end, description: ev.description, extendedProperties: ev.extendedProperties };
  }
  if (opts.borrar) {
    if (!env.GCAL_CALENDAR_ID) return { ok: false, error: "GCAL_CALENDAR_ID no configurado" };
    await deleteEvent(env, env.GCAL_CALENDAR_ID, opts.borrar);
    out.borrado = opts.borrar;
  }
  return out;
}
