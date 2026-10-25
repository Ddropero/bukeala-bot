/**
 * /cancelar_agenda — borra agendas (calendarios) en Bukeala, con confirmación
 * previa y aviso a los pacientes afectados.
 *
 * Flujo seguro (2 pasos):
 *   1. /cancelar_agenda                  → lista las agendas existentes (con id)
 *      o /cancelar_agenda <DD/MM/YYYY>   → filtra las de esa fecha
 *   2. /cancelar_agenda confirmar <id>   → cancela las citas de ESA agenda,
 *      avisa a esos pacientes por WhatsApp, borra el calendario e informa.
 *
 * Maneja los DOS perfiles (niños 1222 + adultos 1218): lista de ambos.
 *
 * Solo doctores. La cancelación de las CITAS individuales se hace con el
 * reservationCode que trae la agenda diaria (getAgenda); si no viene, se
 * reporta para cancelarlas con /cancelar.
 *
 * POR QUÉ hay un filtro por calendario (defecto corregido oct-2026):
 * getAgenda devuelve TODA el área por fecha, no las citas de un calendario.
 * Sin filtrar, cancelar un calendario de niños de la mañana avisó y canceló
 * una cita de adultos de otro calendario por la tarde. La cita no trae id de
 * calendario, así que la pertenencia se decide con lo que sí trae: el perfil
 * (bookingComponentCode) y la hora de inicio dentro de la ventana horaria del
 * calendario. Ver evaluarPertenencia().
 *
 * POR QUÉ se miran las agendas HERMANAS (revisión adversarial oct-2026):
 * /abrir_agenda crea UN calendario por día de la semana, con el mismo rango
 * de fechas (hoy → hoy+14) y las mismas horas. "Lunes 8-12" y "jueves 8-12"
 * son dos calendarios de niños indistinguibles por perfil + ventana. Si el
 * objeto calendario trae el día de la semana (leerDiasSemana), solo se
 * recorren esos días. Si no lo trae, toda cita que también quepa en otra
 * agenda del mismo perfil ese día se marca "no evaluable" en vez de
 * cancelarse: el molde se conserva y el Dr. decide a mano. Lo mismo cubre
 * el borde entre dos calendarios contiguos (8-12 y 12-16).
 *
 * POR QUÉ no se recorren días pasados ni citas ya atendidas: borrar el molde
 * no afecta lo que ya ocurrió, y cancelar/avisar una cita ENDED o
 * NOT_ASSISTED es avisarle a un paciente ya atendido. Solo se tocan citas
 * futuras en estados cancelables (clasificarEstado).
 *
 * POR QUÉ el borrado es condicional (defecto corregido oct-2026):
 * deleteBookingCalendar borra solo el MOLDE; las reservas sobreviven. Si se
 * borra con citas activas, el paciente sigue agendado pero el Dr. pierde la
 * agenda donde verlo y la forma de reintentar el comando. Por eso solo se
 * borra cuando TODAS las citas que le pertenecen quedaron canceladas (o no
 * había ninguna) y el recorrido terminó completo. Ver debeBorrarCalendario().
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { sendText } from "../whatsapp";
import { getContacto } from "../pacientesContacto";

// Los DOS perfiles (verificado en HAR agendas2; mismo mapeo que abrirAgenda.ts):
//   niños/adolescentes → componente 1222, código de reserva "890239-1"
//   adultos            → componente 1218, código de reserva "890239"
// `code` es lo que cada cita de getAgenda trae en bookingComponentCode y es la
// única forma de saber de qué perfil es una cita. Existe un tercer código
// ("890239-2", visto en loadComponents) que NO pertenece a ninguno de los dos
// perfiles de este comando: queda fuera a propósito.
export const PROFILES = [
  { id: "1222", code: "890239-1", label: "Niños/adolescentes" },
  { id: "1218", code: "890239", label: "Adultos" },
] as const;
const AREA_ID = 1074;

// Topes de seguridad para no exceder los límites de subrequests del Worker.
const MAX_DAYS = 31;        // días CONSULTADOS por ejecución (tras recortar pasado y weekday)
const MAX_PATIENTS = 40;    // tope de cancelaciones/avisos por ejecución
const MAX_LIST = 15;        // líneas por bloque en el resumen
const MAX_RANGE_DAYS = 400; // un calendario de más de un año no es un caso real
// Telegram rechaza mensajes > 4096 caracteres y el llamador no parte ni
// comprueba la respuesta: si el resumen se pasa, el Dr. se queda sin informe
// después de acciones irreversibles. Mismo margen que inbox.ts.
const TG_MAX_CHARS = 3900;

const DIA_LABEL = ["", "Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export interface CalInfo {
  id: number;
  desc: string;
  startFmt: string;          // DD/MM/YY
  endFmt: string;            // DD/MM/YY
  startSec: number | null;   // minStartBookingSeconds: segundos desde medianoche (null si no viene)
  endSec: number | null;     // maxStartBookingSeconds: segundos desde medianoche (null si no viene)
  state: string;
  profile: string;           // etiqueta legible del perfil
  profileId: string;         // id del componente consultado (1222 / 1218)
  componentCode: string;     // código que traen las citas en bookingComponentCode
  /** Días de la semana del calendario en numeración Bukeala (Domingo=1 …
   *  Sábado=7), o null si el objeto no los trae. Ver leerDiasSemana(). */
  dias: number[] | null;
}

function secs2hhmm(s: number | null): string {
  if (s === null) return "??:??";
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

function etiquetaDias(dias: number[] | null): string {
  if (!dias || dias.length === 0) return "";
  return dias.map((d) => DIA_LABEL[d] ?? String(d)).join("/");
}

/** Lista calendarios de ambos perfiles. */
async function listCalendars(b: Bukeala): Promise<CalInfo[]> {
  const out: CalInfo[] = [];
  for (const prof of PROFILES) {
    try {
      const res = await b.selectBookingComponent(prof.id);
      const j = await res.json<any>().catch(() => null);
      const cals = j?.bookingComponent?.bookingCalendars ?? [];
      for (const c of cals) {
        out.push({
          id: c.id,
          desc: c.description ?? "",
          startFmt: c.startDateFormatted ?? "",
          endFmt: c.endDateFormatted ?? "",
          // null (no 0) cuando falta: un 0 se confunde con medianoche y la
          // guardia de ventana no dispara (ver ventanaValida).
          startSec: num(c.minStartBookingSeconds),
          endSec: num(c.maxStartBookingSeconds),
          state: c.stateDescription ?? c.stateCode ?? "",
          profile: prof.label,
          profileId: prof.id,
          componentCode: prof.code,
          dias: leerDiasSemana(c),
        });
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      console.log(`[cancelarAgenda] list ${prof.id} falló:`, (e as Error).message);
    }
  }
  return out;
}

/**
 * @param opts.now  instante "actual" (inyectable en tests). Los llamadores
 *                  reales no lo pasan; el contrato { reply, needsRenew? } no cambia.
 */
export async function handleCancelarAgenda(
  env: Env,
  argsText: string,
  opts: { now?: Date } = {},
): Promise<{ reply: string; needsRenew?: boolean }> {
  const b = new Bukeala(env);
  const parts = argsText.trim().split(/\s+/).filter(Boolean);
  const now = opts.now ?? new Date();

  // --- Paso 2: confirmar <id> ---
  if (parts[0]?.toLowerCase() === "confirmar" && parts[1]) {
    const calId = parts[1].replace(/\D/g, "");
    if (!calId) return { reply: "❌ ID de agenda inválido." };
    return await confirmarCancelacion(env, b, calId, now);
  }

  // --- Paso 1: listar ---
  let cals: CalInfo[];
  try {
    cals = await listCalendars(b);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return { reply: "⚠️ Sesión Bukeala caída. La estoy despertando…", needsRenew: true };
    }
    return { reply: `❌ Error listando agendas: ${escapeHtml((e as Error).message.slice(0, 120))}` };
  }

  // Filtro opcional por fecha (DD/MM/YYYY → compara con startFmt DD/MM/YY)
  const dateFilter = parts[0] && /^\d{2}\/\d{2}\/\d{4}$/.test(parts[0]) ? parts[0] : null;
  let shown = cals;
  if (dateFilter) {
    const short = dateFilter.slice(0, 6) + dateFilter.slice(8); // DD/MM/YYYY → DD/MM/YY
    shown = cals.filter((c) => c.startFmt === short || c.desc.includes(short));
  }

  if (shown.length === 0) {
    return { reply: dateFilter
      ? `📭 No hay agendas para ${dateFilter}.`
      : "📭 No hay agendas abiertas en este momento." };
  }

  const lines = [`📋 <b>Agendas abiertas</b>${dateFilter ? ` · ${dateFilter}` : ""}`, ""];
  for (const c of shown.slice(0, 30)) {
    const dias = etiquetaDias(c.dias);
    lines.push(
      `🆔 <code>${c.id}</code> · ${escapeHtml(c.profile)}${dias ? ` · ${escapeHtml(dias)}` : ""}`,
      `   ${escapeHtml(c.startFmt)}→${escapeHtml(c.endFmt)} · ${secs2hhmm(c.startSec)}-${secs2hhmm(c.endSec)} · ${escapeHtml(c.state)}`,
    );
  }
  lines.push("", "<i>Para cancelar una: <code>/cancelar_agenda confirmar &lt;ID&gt;</code></i>");
  lines.push("<i>(Eso cancelará solo las citas futuras de esa agenda, avisará a esos pacientes y borrará la agenda.)</i>");
  return { reply: lines.join("\n") };
}

// ====================================================================
// Funciones puras (exportadas para poder probarlas con objetos literales)
// ====================================================================

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const NOMBRE_DIA: Record<string, number> = {
  domingo: 1, lunes: 2, martes: 3, miercoles: 4, jueves: 5, viernes: 6, sabado: 7,
};

/**
 * Días de la semana de un calendario, en numeración Bukeala (Domingo=1 …
 * Sábado=7; mapeo VERIFICADO en abrirAgenda.ts para daysSelected).
 *
 * CAMPO REAL VERIFICADO (25-oct-2026, volcado crudo con /debug/listSchedules):
 * el objeto calendario de selectBookingComponent trae `dayOfWeeks`, un array
 * de números en la numeración Bukeala (Domingo=1 … Sábado=7). Ejemplo real:
 * un calendario de consulta de los miércoles trae `dayOfWeeks: [4]`, que es
 * el mismo mapeo que usa abrirAgenda.ts al CREAR el molde con daysSelected.
 * Se leen además, de forma defensiva, daysSelected* y unos nombres de texto,
 * por si otra pantalla devuelve el calendario con otra forma. Si nada
 * aparece se devuelve null: el recorrido cubre todos los días del rango y la
 * protección pasa a ser la de agendas hermanas (hermanosDelDia). Números solo
 * se aceptan en dayOfWeeks y daysSelected*; en campos de texto solo nombres
 * de día en español (inequívocos).
 */
export function leerDiasSemana(c: any): number[] | null {
  const out = new Set<number>();
  const addNum = (n: number | null) => { if (n !== null && Number.isInteger(n) && n >= 1 && n <= 7) out.add(n); };
  const addNombres = (s: string) => {
    for (const tok of normalizar(s).split(/[^a-z]+/)) {
      if (tok in NOMBRE_DIA) out.add(NOMBRE_DIA[tok]);
    }
  };
  const leer = (v: unknown, conNumeros: boolean) => {
    if (v == null) return;
    if (Array.isArray(v)) { for (const el of v) leer(el, conNumeros); return; }
    if (typeof v === "number") { if (conNumeros) addNum(v); return; }
    if (typeof v === "string") {
      if (conNumeros) for (const tok of v.split(/[^0-9]+/)) addNum(num(tok));
      addNombres(v);
    }
  };
  for (const campo of ["dayOfWeeks", "daysSelected", "daysSelectedStr", "daysSelectedList"]) leer(c?.[campo], true);
  for (const campo of ["dayDescription", "dayOfWeekDescription", "weekDayDescription", "dayName", "daysDescription", "dayOfWeekInLetters"]) leer(c?.[campo], false);
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

/** Ventana horaria utilizable: ambos extremos numéricos y coherentes. */
export function ventanaValida(v: { startSec: number | null; endSec: number | null }): v is { startSec: number; endSec: number } {
  const a = v.startSec, b = v.endSec;
  return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)
    && a >= 0 && b > 0 && b < 86400 && a <= b;
}

export type EstadoCita = "cancelable" | "descartar" | "desconocido";

// Estados de Bukeala (fuentes/bukeala.ts y stateEmoji de telegram.ts).
// Solo se cancelan los que miran al futuro; una cita atendida (ENDED), no
// asistida, admitida o en curso no se cancela ni se avisa. Un estado que no
// esté en ninguna lista NO se descarta en silencio: se marca no evaluable
// para que el Dr. lo revise (y bloquea el borrado del molde).
const ESTADOS_CANCELABLES = new Set(["PENDING", "PENDING_CONFIRMATION", "PENDING_DATA", "PENDING_PAYMENT", "CONFIRMED", "OVER_BOOKING"]);
const ESTADOS_NO_CANCELABLES = new Set(["CANCELED", "ENDED", "NOT_ASSISTED", "ADMITTED", "STARTED", "PAUSE"]);

export function clasificarEstado(bk: any): EstadoCita {
  if (bk?.isCanceled || bk?.isBusyTime) return "descartar";
  const st = String(bk?.stateCode ?? "").trim().toUpperCase();
  if (ESTADOS_CANCELABLES.has(st)) return "cancelable";
  if (ESTADOS_NO_CANCELABLES.has(st)) return "descartar";
  return "desconocido";
}

/** ¿La cita sigue vigente y se puede cancelar hacia futuro? */
export function esCitaActiva(bk: any): boolean {
  return clasificarEstado(bk) === "cancelable";
}

/** "08:20 AM" / "8:20 p.m." (12 h, regex de parseHora12 en espejoCalendar.ts) o "HH:MM" (24 h). */
function parseHoraTexto(s: string): number | null {
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i);
  if (m12) {
    let hh = parseInt(m12[1], 10);
    const mm = parseInt(m12[2], 10);
    if (hh === 12) hh = 0;
    if (m12[3].toUpperCase() === "P") hh += 12;
    return hh < 24 && mm < 60 ? hh * 3600 + mm * 60 : null;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const hh = parseInt(m24[1], 10);
    const mm = parseInt(m24[2], 10);
    return hh < 24 && mm < 60 ? hh * 3600 + mm * 60 : null;
  }
  return null;
}

/**
 * Hora de inicio de la cita en segundos desde medianoche.
 *
 * Hay dos fuentes: startHourFormatted (12 h, el campo que usan TODOS los demás
 * lectores de getAgenda del repo: espejoCalendar, telegram, mcp) y
 * startHours/startMinutes (numéricos, sin ningún otro lector en el repo y sin
 * muestra cruda que confirme si son base 24 o base 12). Si solo existe una,
 * se usa. Si existen las dos y NO coinciden, se devuelve null con motivo:
 * confiar en la numérica podría dejar fuera en silencio una cita de la tarde
 * (startHours=3 para "03:00 PM" daría 10800 s), que es el peor modo de fallo
 * del comando (molde borrado con la cita viva). Con null la cita queda "no
 * evaluable", bloquea el borrado y el Dr. la ve.
 */
export function leerHoraInicio(bk: any): { seg: number | null; motivo?: string } {
  const h = num(bk?.startHours);
  const m = num(bk?.startMinutes);
  const numerica = (h !== null && m !== null && h >= 0 && h < 24 && m >= 0 && m < 60) ? h * 3600 + m * 60 : null;
  const texto = String(bk?.startHourFormatted ?? "").trim();
  const formateada = parseHoraTexto(texto);
  if (formateada !== null && numerica !== null) {
    if (formateada !== numerica) {
      return { seg: null, motivo: `startHours/startMinutes (${h}:${String(m).padStart(2, "0")}) no coincide con startHourFormatted ("${texto}")` };
    }
    return { seg: formateada };
  }
  if (formateada !== null) return { seg: formateada };
  if (numerica !== null) return { seg: numerica };
  return { seg: null, motivo: "no se pudo leer la hora de inicio" };
}

export function horaInicioSegundos(bk: any): number | null {
  return leerHoraInicio(bk).seg;
}

export type Pertenencia = {
  pertenece: boolean;
  /** Presente cuando NO se pudo decidir (falta el perfil o la hora de la cita,
   *  la ventana del calendario es inválida, o la cita cabe en otra agenda). */
  noEvaluable?: string;
};

export type CalVentana = { componentCode: string; startSec: number | null; endSec: number | null };

/** Otra agenda del mismo perfil que cubre el mismo día (ver hermanosDelDia). */
export type Hermano = { id: number | string; etiqueta: string; startSec: number | null; endSec: number | null };

/**
 * Decide si una cita de getAgenda pertenece al calendario que se va a borrar.
 * Reglas (todas en AND):
 *
 *  0. VENTANA DEL CALENDARIO válida (ventanaValida). Si falta un extremo o
 *     max < min, NINGUNA cita se puede atribuir: noEvaluable (nunca "otra
 *     agenda", que dejaría propias=[] y borraría el molde con citas vivas).
 *
 *  1. PERFIL: bookingComponentCode de la cita === componentCode del calendario,
 *     comparación EXACTA. Nunca startsWith/includes: "890239" (adultos) es
 *     prefijo de "890239-1" (niños) y de "890239-2" (tercer perfil). Un código
 *     distinto es simplemente otro perfil: no pertenece y no es un error. Si la
 *     cita no trae código, NO se inventa a partir de bookingComponentName: se
 *     marca noEvaluable para que el Dr. la revise a mano.
 *
 *  2. VENTANA HORARIA: startSec <= inicio de la cita <= endSec, INCLUSIVA en
 *     ambos extremos. minStartBookingSeconds es claramente el primer cupo.
 *     maxStartBookingSeconds no está documentado (¿fin del bloque o inicio del
 *     último cupo?). Ser inclusivo evita dejar sin cancelar ni avisar al
 *     paciente del último cupo si fuera "inicio del último cupo"; y si fuera
 *     "fin del bloque", la cita de las 12:00 solo puede existir si otra agenda
 *     del mismo perfil la cubre, caso que la regla 3 convierte en noEvaluable.
 *     Si la hora no se puede leer (o sus dos fuentes se contradicen), noEvaluable.
 *
 *  3. AGENDAS HERMANAS: si la hora de la cita también cae en la ventana de
 *     otra agenda del mismo perfil que cubre ese día (o esa otra agenda no
 *     tiene ventana legible), la cita no es atribuible → noEvaluable con el id
 *     de la hermana. La cita no trae id de calendario y no hay forma de
 *     separarlas; antes se cancelaban (defecto 1 entre calendarios del mismo
 *     perfil: lunes 8-12 vs jueves 8-12, o 8-12 vs 12-16 el mismo día).
 *
 *  El día de la semana y el rango de fechas se aplican FUERA de esta función
 *  (planificarDias / hermanosDelDia); el área la da getAgenda (1074).
 */
export function evaluarPertenencia(bk: any, cal: CalVentana, hermanos: Hermano[] = []): Pertenencia {
  if (!ventanaValida(cal)) return { pertenece: false, noEvaluable: "la agenda no trae una ventana horaria válida" };
  const code = String(bk?.bookingComponentCode ?? "").trim();
  if (!code) return { pertenece: false, noEvaluable: "la cita no trae código de perfil" };
  if (code !== cal.componentCode) return { pertenece: false };
  const hora = leerHoraInicio(bk);
  if (hora.seg === null) return { pertenece: false, noEvaluable: hora.motivo ?? "no se pudo leer la hora de inicio" };
  const s = hora.seg;
  if (!(cal.startSec <= s && s <= cal.endSec)) return { pertenece: false };
  for (const h of hermanos) {
    const cabe = !ventanaValida(h) || (h.startSec <= s && s <= h.endSec);
    if (cabe) return { pertenece: false, noEvaluable: `también cabe en la agenda ${h.id} (${h.etiqueta})` };
  }
  return { pertenece: true };
}

export function perteneceAlCalendario(bk: any, cal: CalVentana, hermanos: Hermano[] = []): boolean {
  return evaluarPertenencia(bk, cal, hermanos).pertenece;
}

/**
 * Separa las citas de un día en las que pertenecen al calendario y se pueden
 * cancelar, y las que no se pudieron evaluar. Las de otro perfil u otra franja
 * no se devuelven: no se tocan ni se cuentan. Las canceladas, bloqueos y
 * citas ya atendidas/en curso se descartan antes.
 *
 * @param opts.hermanos  otras agendas del mismo perfil que cubren ese día
 * @param opts.despuesDe solo para HOY: segundos actuales en Bogotá; una cita
 *                       que ya empezó no se cancela ni se avisa.
 */
export function filtrarCitasDelCalendario(
  bookings: any[],
  cal: CalVentana,
  opts: { hermanos?: Hermano[]; despuesDe?: number | null } = {},
): { propias: any[]; noEvaluables: Array<{ bk: any; motivo: string }> } {
  const propias: any[] = [];
  const noEvaluables: Array<{ bk: any; motivo: string }> = [];
  for (const bk of bookings ?? []) {
    const estado = clasificarEstado(bk);
    if (estado === "descartar") continue;
    const p = evaluarPertenencia(bk, cal, opts.hermanos ?? []);
    if (p.noEvaluable) { noEvaluables.push({ bk, motivo: p.noEvaluable }); continue; }
    if (!p.pertenece) continue;
    if (opts.despuesDe != null) {
      const s = horaInicioSegundos(bk);
      if (s !== null && s <= opts.despuesDe) continue; // ya empezó: no se cancela ni se avisa
    }
    if (estado === "desconocido") {
      noEvaluables.push({ bk, motivo: `estado "${String(bk?.stateCode ?? "")}" no reconocido` });
      continue;
    }
    propias.push(bk);
  }
  return { propias, noEvaluables };
}

/**
 * Convención real de Bukeala (igual en /cancelar de telegram.ts, en
 * claudeBookingAgent.ts y en deleteBookingCalendar aquí mismo): el éxito NO se
 * infiere del status HTTP sino del cuerpo JSON. Un rechazo funcional llega
 * como HTTP 200 con result.code distinto de "SUCCESS" y NO lanza.
 */
export function evaluarRespuestaBukeala(j: any): { ok: boolean; msg: string } {
  const ok = j?.result?.code === "SUCCESS";
  const raw = j?.result?.description ?? j?.messages?.[0]?.description ?? (j == null ? "respuesta vacía o no JSON" : "sin detalle");
  return { ok, msg: stripHtmlTags(String(raw)).trim().slice(0, 150) };
}

// ---------------------------------------------------------------------
// Fechas y días
// ---------------------------------------------------------------------

export type Dia = { dd: string; mm: string; yyyy: string };

/** "DD/MM/YY" → medianoche UTC de ese día (siglo 20YY), o null si no se puede leer. */
export function parseDdMmYy(s: string): Date | null {
  const m = String(s ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(2000 + parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10)));
  return Number.isFinite(d.getTime()) ? d : null;
}

export function diaUtc(d: Dia): Date {
  return new Date(Date.UTC(parseInt(d.yyyy, 10), parseInt(d.mm, 10) - 1, parseInt(d.dd, 10)));
}

/** Día de la semana en numeración Bukeala (Domingo=1 … Sábado=7; abrirAgenda.ts:151). */
export function diaSemanaBukeala(d: Dia): number {
  return diaUtc(d).getUTCDay() + 1;
}

/**
 * Enumera los días entre dos fechas "DD/MM/YY" (inclusive), con tope maxDays.
 * Devuelve [] si CUALQUIERA de las dos fechas es ilegible: antes un fin vacío
 * se degradaba en silencio a un solo día y el molde de un calendario de
 * semanas se borraba tras revisar únicamente el primero.
 */
export function enumerateDays(startFmt: string, endFmt: string, maxDays: number): Dia[] {
  const start = parseDdMmYy(startFmt);
  const end = parseDdMmYy(endFmt);
  if (!start || !end) return [];
  const out: Dia[] = [];
  const cur = new Date(start.getTime());
  const last = end.getTime() >= start.getTime() ? end : start;
  for (let i = 0; i < maxDays; i++) {
    out.push({
      dd: String(cur.getUTCDate()).padStart(2, "0"),
      mm: String(cur.getUTCMonth() + 1).padStart(2, "0"),
      yyyy: String(cur.getUTCFullYear()),
    });
    if (cur.getTime() >= last.getTime()) break;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Hoy en Bogotá (UTC-5, sin horario de verano): medianoche UTC del día y segundos transcurridos. */
export function hoyBogota(now: Date): { medianoche: Date; segundos: number } {
  const bog = new Date(now.getTime() - 5 * 3600 * 1000);
  return {
    medianoche: new Date(Date.UTC(bog.getUTCFullYear(), bog.getUTCMonth(), bog.getUTCDate())),
    segundos: bog.getUTCHours() * 3600 + bog.getUTCMinutes() * 60 + bog.getUTCSeconds(),
  };
}

/**
 * ¿Un calendario cubre ese día? Rango de fechas inclusivo y, si trae días de
 * la semana, el día debe ser uno de ellos. Fechas ilegibles → true: para una
 * agenda hermana lo conservador es suponer que sí la cubre.
 */
export function calendarioCubreDia(c: { startFmt: string; endFmt: string; dias: number[] | null }, d: Dia): boolean {
  const start = parseDdMmYy(c.startFmt);
  const end = parseDdMmYy(c.endFmt);
  const t = diaUtc(d).getTime();
  if (start && t < start.getTime()) return false;
  if (end && t > end.getTime()) return false;
  if (c.dias && c.dias.length > 0 && !c.dias.includes(diaSemanaBukeala(d))) return false;
  return true;
}

/**
 * Agendas hermanas: otros calendarios del MISMO perfil que cubren ese día y
 * cuya ventana horaria se solapa con la del calendario objetivo (o no es
 * legible, que se trata como solape total). Las citas que caigan en la
 * intersección no son atribuibles (evaluarPertenencia, regla 3).
 * No se filtra por stateDescription: no hay catálogo de estados de calendario
 * en el repo y un calendario vencido ya queda fuera por su rango de fechas.
 */
export function hermanosDelDia(cal: CalInfo, todos: CalInfo[], d: Dia): Hermano[] {
  const out: Hermano[] = [];
  for (const c of todos) {
    if (String(c.id) === String(cal.id)) continue;
    if (c.componentCode !== cal.componentCode) continue;
    if (!calendarioCubreDia(c, d)) continue;
    const solapa = !ventanaValida(c) || !ventanaValida(cal)
      || (c.startSec <= cal.endSec && cal.startSec <= c.endSec);
    if (!solapa) continue;
    out.push({
      id: c.id,
      etiqueta: `${c.profile} ${secs2hhmm(c.startSec)}-${secs2hhmm(c.endSec)} ${c.startFmt}→${c.endFmt}${c.dias ? " " + etiquetaDias(c.dias) : ""}`,
      startSec: c.startSec,
      endSec: c.endSec,
    });
  }
  return out;
}

/**
 * Días que hay que consultar para un calendario: su rango de fechas, SIN los
 * días ya pasados (borrar el molde no cambia lo que ya ocurrió y una cita de
 * ayer no se cancela ni se avisa) y, si se conocen, solo sus días de la
 * semana. Hoy se incluye (el filtro por hora se aplica cita a cita).
 */
export function planificarDias(
  cal: Pick<CalInfo, "startFmt" | "endFmt" | "dias">,
  hoyMedianoche: Date,
): { ok: true; dias: Dia[]; pasados: number } | { ok: false; motivo: string } {
  if (!parseDdMmYy(cal.startFmt)) return { ok: false, motivo: `fecha de inicio "${cal.startFmt}"` };
  if (!parseDdMmYy(cal.endFmt)) return { ok: false, motivo: `fecha de fin "${cal.endFmt}"` };
  const todos = enumerateDays(cal.startFmt, cal.endFmt, MAX_RANGE_DAYS + 1);
  if (todos.length > MAX_RANGE_DAYS) return { ok: false, motivo: `rango de más de ${MAX_RANGE_DAYS} días` };
  const hoy = hoyMedianoche.getTime();
  const futuros = todos.filter((d) => diaUtc(d).getTime() >= hoy);
  const dias = cal.dias && cal.dias.length > 0
    ? futuros.filter((d) => cal.dias!.includes(diaSemanaBukeala(d)))
    : futuros;
  return { ok: true, dias, pasados: todos.length - futuros.length };
}

// ---------------------------------------------------------------------
// Resultado del recorrido y resumen
// ---------------------------------------------------------------------

export interface CitaResumen {
  nombre: string;
  fecha: string;   // DD/MM/YY
  hora: string;    // tal como la trae Bukeala
  detalle?: string;
}

/** Lo que pasó durante el recorrido día a día. Todo contado por separado. */
export interface ResultadoRecorrido {
  canceladas: CitaResumen[];
  cancelFallidas: CitaResumen[];   // detalle = motivo que dio Bukeala
  sinCodigo: CitaResumen[];        // sin reservationCode: cancelar con /cancelar
  noEvaluables: CitaResumen[];     // detalle = por qué no se pudo decidir
  /** Mensaje ACEPTADO por Meta. No significa entregado: fuera de la ventana de
   *  24 h el texto libre se acepta y falla después por webhook de estado. */
  avisados: CitaResumen[];
  avisosFallidos: CitaResumen[];   // detalle = error de Meta
  sinTelefono: CitaResumen[];
  diasRecorridos: number;
  diasPasadosOmitidos: number;     // días del rango anteriores a hoy (no se consultan)
  hermanosSolapados: string[];     // agendas hermanas con solape en algún día revisado
  truncado: boolean;               // el recorrido NO cubrió todo el calendario
  motivoTruncado?: string;
  errorRecorrido?: string;         // excepción (no de sesión) que cortó el bucle
  sesionCaida?: boolean;           // SessionExpiredError a mitad del bucle
}

export function nuevoResultado(): ResultadoRecorrido {
  return {
    canceladas: [], cancelFallidas: [], sinCodigo: [], noEvaluables: [],
    avisados: [], avisosFallidos: [], sinTelefono: [],
    diasRecorridos: 0, diasPasadosOmitidos: 0, hermanosSolapados: [], truncado: false,
  };
}

/**
 * Borrar el molde SOLO si el recorrido terminó completo y no quedó ninguna
 * cita del calendario sin cancelar ni sin evaluar. En cualquier otro caso el
 * calendario se queda para que el Dr. vea las citas y pueda reintentar: el
 * comando es idempotente (las ya canceladas salen por isCanceled y el aviso
 * va después de la cancelación, así que no se avisa dos veces).
 */
export function debeBorrarCalendario(r: ResultadoRecorrido): { borrar: boolean; motivos: string[] } {
  const motivos: string[] = [];
  if (r.sesionCaida) motivos.push("la sesión de Bukeala se cayó a mitad del recorrido");
  if (r.errorRecorrido) motivos.push(`el recorrido se interrumpió (${r.errorRecorrido})`);
  if (r.truncado) motivos.push(`el recorrido quedó incompleto: ${r.motivoTruncado ?? "tope de seguridad"}`);
  if (r.cancelFallidas.length > 0) motivos.push(`${r.cancelFallidas.length} cita(s) no se pudieron cancelar`);
  if (r.sinCodigo.length > 0) motivos.push(`${r.sinCodigo.length} cita(s) no traen código de reserva`);
  if (r.noEvaluables.length > 0) motivos.push(`${r.noEvaluables.length} cita(s) no se pudieron evaluar`);
  return { borrar: motivos.length === 0, motivos };
}

export interface EstadoBorrado {
  hecho: boolean;
  motivos: string[];   // por qué NO se intentó borrar (de debeBorrarCalendario)
  error?: string;      // se intentó y Bukeala lo rechazó / falló
}

function recortar(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Resumen al doctor. Refleja exactamente lo que pasó, sin afirmar de más, y
 * cabe SIEMPRE en un mensaje de Telegram: cabecera y pie son fijos, y los
 * bloques de detalle se reparten el presupuesto restante por prioridad (lo
 * accionable primero: a quién llamar, qué no se pudo cancelar). Cada bloque
 * conserva al menos su cabecera y su "… y N más".
 */
export function resumirResultado(
  cal: CalInfo,
  calId: string,
  r: ResultadoRecorrido,
  borrado: EstadoBorrado,
): string {
  const rango = cal.startFmt === cal.endFmt ? cal.startFmt : `${cal.startFmt}→${cal.endFmt}`;
  const dias = etiquetaDias(cal.dias ?? null);
  const afectadas = r.canceladas.length + r.cancelFallidas.length + r.sinCodigo.length;
  const titulo = borrado.hecho
    ? "✅ <b>Agenda cancelada</b>"
    : borrado.error
      ? "❌ <b>Agenda NO borrada</b> (Bukeala rechazó el borrado)"
      : "⚠️ <b>Agenda NO borrada</b>";
  const cab = [
    titulo,
    `🆔 <code>${escapeHtml(calId)}</code> · ${escapeHtml(cal.profile)} · ${escapeHtml(rango)}${dias ? ` · ${escapeHtml(dias)}` : ""} · ${secs2hhmm(cal.startSec)}-${secs2hhmm(cal.endSec)}`,
    `📅 Días revisados: ${r.diasRecorridos}${r.truncado ? " (recorrido INCOMPLETO)" : ""}${r.diasPasadosOmitidos > 0 ? ` · ${r.diasPasadosOmitidos} día(s) ya pasados no se revisan` : ""}`,
    ``,
    `👥 Citas de esta agenda: ${afectadas}`,
    `   ✅ Canceladas: ${r.canceladas.length}`,
    `   ❌ No canceladas: ${r.cancelFallidas.length}`,
  ];
  if (r.sinCodigo.length > 0) cab.push(`   🔖 Sin código de reserva: ${r.sinCodigo.length}`);
  if (r.noEvaluables.length > 0) cab.push(`   ❓ No pude decidir si son de esta agenda: ${r.noEvaluables.length}`);
  cab.push(
    `📲 Avisos aceptados por WhatsApp: ${r.avisados.length}`,
    `⚠️ Avisos fallidos: ${r.avisosFallidos.length}`,
  );
  if (r.sinTelefono.length > 0) cab.push(`📵 Sin teléfono: ${r.sinTelefono.length}`);
  if (r.hermanosSolapados.length > 0) {
    cab.push(`⚠️ Agendas hermanas del mismo perfil con horario solapado: ${escapeHtml(r.hermanosSolapados.slice(0, 5).join("; "))}`);
  }

  const pie = [""];
  if (borrado.hecho) {
    pie.push("🗑 Agenda borrada en Bukeala.");
  } else {
    const motivos = borrado.error ? [`Bukeala respondió: ${borrado.error}`] : borrado.motivos;
    pie.push(`🚫 <b>La agenda sigue existiendo</b>: ${escapeHtml(motivos.join("; "))}.`);
    const repetir = `<code>/cancelar_agenda confirmar ${escapeHtml(calId)}</code>`;
    if (r.sesionCaida) {
      pie.push(`➡️ Estoy despertando la sesión. Cuando vuelva, repite ${repetir}: las citas ya canceladas no se repiten ni se avisan dos veces.`);
    } else if (r.hermanosSolapados.length > 0 && r.noEvaluables.length > 0) {
      pie.push(`➡️ Hay otra agenda del mismo perfil con horario solapado y no puedo saber a cuál pertenece cada cita. Cancela esas citas con /cancelar (o desde Bukeala, donde sí se ve la agenda de cada una) y repite ${repetir}.`);
    } else if (r.truncado) {
      pie.push(`➡️ Repite ${repetir} para seguir con las citas restantes: las ya canceladas no se repiten ni se avisan dos veces.`);
    } else {
      pie.push(`➡️ Resuelve lo pendiente y repite ${repetir}: las citas ya canceladas no se repiten ni se avisan dos veces.`);
    }
  }

  const bloques = [
    { cab: "☎️ <b>Canceladas SIN aviso</b> (llamar al paciente):", items: [...r.avisosFallidos, ...r.sinTelefono], conDetalle: true },
    { cab: "❌ <b>No canceladas</b> (cancélalas con /cancelar y repite el comando):", items: r.cancelFallidas, conDetalle: true },
    { cab: "🔖 <b>Sin código de reserva</b> (cancélalas con /cancelar y repite el comando):", items: r.sinCodigo, conDetalle: false },
    { cab: "❓ <b>No evaluables</b> (revisa a mano si son de esta agenda):", items: r.noEvaluables, conDetalle: true },
    { cab: "✅ <b>Canceladas y avisadas</b>:", items: r.avisados, conDetalle: false },
  ];
  const cabTxt = cab.join("\n");
  const pieTxt = pie.join("\n");
  const cuerpo = componerBloques(TG_MAX_CHARS - cabTxt.length - pieTxt.length - 2, bloques);
  return [cabTxt, ...cuerpo, pieTxt].join("\n");
}

function componerBloques(
  presupuesto: number,
  bloques: Array<{ cab: string; items: CitaResumen[]; conDetalle: boolean }>,
): string[] {
  const activos = bloques.filter((b) => b.items.length > 0);
  const linea = (it: CitaResumen, conDetalle: boolean) =>
    `• ${escapeHtml(recortar(it.nombre, 60))} ${escapeHtml(it.fecha)} ${escapeHtml(it.hora)}` +
    (conDetalle && it.detalle ? ` — ${escapeHtml(recortar(it.detalle, 100))}` : "");
  const resto = (n: number) => `  … y ${n} más`;
  // Reserva fija: cabecera y "… y N más" de cada bloque, para que todos
  // aparezcan aunque no quepa ninguno de sus ítems.
  let libre = presupuesto - activos.reduce((acc, b) => acc + 1 + b.cab.length + 1 + resto(b.items.length).length + 1, 0);
  const out: string[] = [];
  for (const b of activos) {
    out.push("", b.cab);
    let mostrados = 0;
    for (const it of b.items) {
      if (mostrados >= MAX_LIST) break;
      const l = linea(it, b.conDetalle);
      if (l.length + 1 > libre) break;
      out.push(l);
      libre -= l.length + 1;
      mostrados++;
    }
    if (mostrados < b.items.length) out.push(resto(b.items.length - mostrados));
  }
  return out;
}

// ====================================================================
// Orquestación
// ====================================================================

async function confirmarCancelacion(
  env: Env,
  b: Bukeala,
  calId: string,
  now: Date,
): Promise<{ reply: string; needsRenew?: boolean }> {
  // 1. Ubicar el calendario (para saber fecha/horas/perfil y avisar pacientes).
  //    La lista completa se conserva: sirve para detectar agendas hermanas.
  let todos: CalInfo[] = [];
  let cal: CalInfo | undefined;
  try {
    todos = await listCalendars(b);
    cal = todos.find((c) => String(c.id) === calId);
  } catch (e) {
    if (e instanceof SessionExpiredError) return { reply: "⚠️ Sesión caída. La estoy despertando…", needsRenew: true };
  }
  if (!cal) {
    return { reply: `❌ No encontré la agenda <code>${escapeHtml(calId)}</code>. Lista con /cancelar_agenda.` };
  }

  // Guardias: sin ventana horaria válida o sin fechas legibles no hay forma de
  // saber qué citas pertenecen al calendario. Antes se borraba "con 0
  // pacientes"; ahora se aborta sin tocar nada. Se exige la ventana COMPLETA y
  // coherente (no solo "ambos en 0"): con min presente y max ausente ninguna
  // cita caía en la ventana y el molde se borraba con pacientes vivos.
  if (!ventanaValida(cal)) {
    const min = cal.startSec === null ? "ausente" : String(cal.startSec);
    const max = cal.endSec === null ? "ausente" : String(cal.endSec);
    return { reply: `❌ La agenda <code>${escapeHtml(calId)}</code> no trae una ventana horaria válida (minStartBookingSeconds=${min}, maxStartBookingSeconds=${max}), así que no puedo saber qué citas le pertenecen. No cancelé ni borré nada; bórrala desde Bukeala.` };
  }
  const hoy = hoyBogota(now);
  const plan = planificarDias(cal, hoy.medianoche);
  if (!plan.ok) {
    return { reply: `❌ No pude interpretar la ${escapeHtml(plan.motivo)} de la agenda <code>${escapeHtml(calId)}</code>. No cancelé ni borré nada.` };
  }
  // Rango demasiado largo: se sabe de antemano que el molde no se borraría,
  // así que no tiene sentido ejecutar hasta 40 cancelaciones y avisos
  // irreversibles que el Dr. tendría que terminar a mano. Se aborta ANTES.
  if (plan.dias.length > MAX_DAYS) {
    return { reply: `❌ La agenda <code>${escapeHtml(calId)}</code> tiene ${plan.dias.length} días por revisar (${escapeHtml(cal.startFmt)}→${escapeHtml(cal.endFmt)}) y reviso como máximo ${MAX_DAYS} por ejecución. No cancelé ni borré nada. Cancela las citas con /cancelar y borra la agenda desde Bukeala.` };
  }

  // 2. Recorrer los días planificados. Un calendario puede cubrir varios días
  //    (agenda recurrente); al borrar el molde, todos esos días se quedan sin
  //    agenda. De cada día se toman SOLO las citas que pertenecen a este
  //    calendario (perfil + ventana horaria, sin hermanas); el resto no se toca.
  const r = nuevoResultado();
  r.diasPasadosOmitidos = plan.pasados;
  const hermanosVistos = new Set<string>();
  const procesadas = () => r.canceladas.length + r.cancelFallidas.length + r.sinCodigo.length;

  try {
    for (const d of plan.dias) {
      const dashed = `${d.dd}-${d.mm}-${d.yyyy}`;      // DD-MM-YYYY
      const human = `${d.dd}/${d.mm}/${d.yyyy.slice(2)}`; // DD/MM/YY
      const esHoy = diaUtc(d).getTime() === hoy.medianoche.getTime();
      const res = await b.getAgenda(dashed, AREA_ID, false);
      const j = await res.json<any>().catch(() => null);
      const bookings: any[] = j?.areas?.[0]?.bookings ?? [];
      const hermanos = hermanosDelDia(cal, todos, d);
      for (const h of hermanos) hermanosVistos.add(`${h.id} (${h.etiqueta})`);
      const { propias, noEvaluables } = filtrarCitasDelCalendario(bookings, cal, {
        hermanos,
        despuesDe: esHoy ? hoy.segundos : null,
      });
      for (const ne of noEvaluables) r.noEvaluables.push(resumenCita(ne.bk, human, ne.motivo));

      for (const bk of propias) {
        // El tope se comprueba solo cuando queda una cita por procesar: 40
        // exactas cierran limpio; la 41.ª trunca.
        if (procesadas() >= MAX_PATIENTS) {
          r.truncado = true;
          r.motivoTruncado = `tope de ${MAX_PATIENTS} pacientes por ejecución`;
          break;
        }
        const item = resumenCita(bk, human);
        const rc = bk.reservationCode ?? bk.reservationCodeStr ?? null;
        if (!rc) { r.sinCodigo.push(item); continue; }

        // 1.º Cancelar la cita. "12" = "No disponibilidad de profesional"
        // (motivo válido del catálogo de cancelBooking; NO confundir con el
        // reasonId de saveDenyDate). El éxito se lee del cuerpo, no del status.
        let cancel: { ok: boolean; msg: string };
        try {
          const cres = await b.cancelBooking({ reservationCode: String(rc), cancelReasonId: "12", cancelationComment: "Agenda cancelada por el Dr." });
          cancel = evaluarRespuestaBukeala(await cres.json<any>().catch(() => null));
        } catch (e) {
          // La sesión caída se relanza: seguir el bucle contaría todo como
          // "no cancelada" y escondería la causa real.
          if (e instanceof SessionExpiredError) throw e;
          cancel = { ok: false, msg: (e as Error).message.slice(0, 120) };
        }
        if (!cancel.ok) { r.cancelFallidas.push({ ...item, detalle: cancel.msg }); continue; }
        r.canceladas.push(item);

        // 2.º Avisar SOLO si la cita quedó cancelada (no se avisa de una
        //     cancelación que no ocurrió). Bukeala no expone teléfono: se usa
        //     el directorio propio (pacientesContacto) por cédula.
        const phone = await resolverTelefono(env, bk);
        if (!phone) { r.sinTelefono.push({ ...item, detalle: "sin teléfono en el directorio" }); continue; }
        try {
          const wa = await sendText(
            env,
            phone,
            `Hola ${item.nombre.split(" ")[0]}, lamentamos informarle que su cita del ${human} a las ${item.hora} con el Dr. David Duque debe ser reprogramada. Por favor escríbanos para reagendar. Disculpe el inconveniente.`,
          );
          // sendText no lanza por un rechazo de Meta: hay que mirar ok.
          if (wa.ok) r.avisados.push(item);
          else r.avisosFallidos.push({ ...item, detalle: String(wa.data?.error?.message ?? `WhatsApp HTTP ${wa.status}`).slice(0, 100) });
        } catch (e) {
          r.avisosFallidos.push({ ...item, detalle: (e as Error).message.slice(0, 100) });
        }
      }
      if (r.truncado) break;
      r.diasRecorridos++;
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      r.sesionCaida = true;
    } else {
      r.errorRecorrido = (e as Error).message.slice(0, 120);
      console.log("[cancelarAgenda] recorrido falló:", (e as Error).message);
    }
  }
  r.hermanosSolapados = [...hermanosVistos];

  // Sesión caída a mitad: devolver lo ya hecho (para no perder el rastro de
  // lo cancelado) y pedir renovación. El molde queda intacto.
  if (r.sesionCaida) {
    const decision = debeBorrarCalendario(r);
    return { reply: resumirResultado(cal, calId, r, { hecho: false, motivos: decision.motivos }), needsRenew: true };
  }

  // 3. Borrar el calendario (molde) SOLO si todo quedó limpio.
  const decision = debeBorrarCalendario(r);
  const borrado: EstadoBorrado = { hecho: false, motivos: decision.motivos };
  if (decision.borrar) {
    try {
      const res = await b.deleteBookingCalendar([calId]);
      const ev = evaluarRespuestaBukeala(await res.json<any>().catch(() => null));
      if (ev.ok) borrado.hecho = true;
      else borrado.error = ev.msg;
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        return { reply: resumirResultado(cal, calId, r, { hecho: false, motivos: ["la sesión de Bukeala se cayó al intentar borrar el molde"] }), needsRenew: true };
      }
      borrado.error = (e as Error).message.slice(0, 120);
    }
  }

  // 4. Resumen al doctor
  return { reply: resumirResultado(cal, calId, r, borrado) };
}

function resumenCita(bk: any, fecha: string, detalle?: string): CitaResumen {
  const horaTxt = String(bk?.startHourFormatted ?? "").trim();
  const item: CitaResumen = {
    nombre: String(bk?.name ?? "Paciente").trim() || "Paciente",
    fecha,
    hora: horaTxt || secs2hhmm(horaInicioSegundos(bk)),
  };
  if (detalle) item.detalle = detalle;
  return item;
}

/**
 * Teléfono del paciente. getAgenda no lo trae (extractPhone queda por si algún
 * día lo expone); la fuente real es el directorio propio por cédula.
 */
async function resolverTelefono(env: Env, bk: any): Promise<string> {
  const directo = extractPhone(bk);
  if (directo) return directo;
  try {
    const c = await getContacto(env, String(bk?.identification ?? ""));
    return (c?.telefono ?? "").trim();
  } catch {
    return "";
  }
}

function extractPhone(bk: any): string {
  if (typeof bk.cellPhone === "string" && bk.cellPhone.trim()) return bk.cellPhone.trim();
  if (bk.cellPhone && typeof bk.cellPhone === "object" && bk.cellPhone.phoneNumber) {
    return String(bk.cellPhone.phoneNumber).trim();
  }
  if (typeof bk.phone === "string" && bk.phone.trim()) return bk.phone.trim();
  if (typeof bk.customerPhone === "string" && bk.customerPhone.trim()) return bk.customerPhone.trim();
  return "";
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
