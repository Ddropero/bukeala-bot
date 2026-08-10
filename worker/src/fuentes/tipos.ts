/**
 * Fuente de agenda — capa que desacopla "de dónde salen las citas" del resto
 * del sistema.
 *
 * POR QUÉ EXISTE
 * El valor del producto (recordatorios, confirmación por botón, lista de
 * llamadas, agente de WhatsApp) no depende de Bukeala: depende de tener una
 * lista de citas con nombre, hora y contacto. Bukeala es el eslabón más
 * frágil — portal de un tercero, reCAPTCHA, TGC que muere cada ~6h — y además
 * solo sirve a médicos adscritos a Colsanitas.
 *
 * Con esta interfaz, la misma maquinaria sirve para un cirujano particular que
 * lleva su agenda en Google Calendar, sin tocar Colsanitas.
 *
 * REGLA: nada fuera de `fuentes/` debe saber de qué fuente vienen los datos.
 * Si un módulo necesita un campo que solo da Bukeala, va en `extra`.
 */
import type { Env } from "../env";

/** Estado normalizado. Cada fuente mapea su vocabulario a estos. */
export type EstadoCita =
  | "pendiente"    // agendada, sin confirmar
  | "confirmada"   // el paciente confirmó
  | "en_curso"     // admitido / iniciado
  | "atendida"     // terminó
  | "no_asistio"
  | "cancelada"
  | "desconocido";

/** Una cita, ya normalizada. Es el único formato que ve el resto del sistema. */
export interface Cita {
  /** Id estable dentro de la fuente (para llaves de KV, confirmaciones, etc.). */
  id: string;
  /** "08:20 AM" — hora local de Bogotá, tal como se le muestra al humano. */
  hora: string;
  horaFin: string;
  /** Minutos desde medianoche. Para ordenar y comparar sin parsear strings. */
  horaMin: number;
  paciente: string;
  /** Documento con tipo si la fuente lo da: "CC 1020304050". Vacío si no. */
  documento: string;
  /** E.164 sin "+" si se conoce. Vacío si la fuente no lo expone. */
  telefono: string;
  email: string;
  estado: EstadoCita;
  /** Texto del estado tal como lo dice la fuente (para mostrar sin traducir). */
  estadoTexto: string;
  presencial: boolean | null;
  notas: string;
  /** Campos propios de la fuente que no caben en el modelo común. */
  extra?: Record<string, unknown>;
}

export interface DiaAgenda {
  /** DD-MM-YYYY */
  fecha: string;
  /** Como se le muestra al humano: "05/08/26". */
  fechaLegible: string;
  citas: Cita[];
}

/**
 * Una fuente de agenda. Implementarla es todo lo que hace falta para que un
 * cliente nuevo use el sistema completo.
 */
export interface FuenteAgenda {
  /** Identificador corto: "bukeala", "gcal". Va en logs y respuestas de API. */
  readonly nombre: string;

  /** ¿Está configurada esta fuente en este entorno? Si no, no se ofrece. */
  disponible(env: Env): boolean;

  /**
   * Citas de un día. `fecha` en DD-MM-YYYY.
   * Debe devolver las citas ACTIVAS (sin canceladas ni bloqueos de agenda)
   * ordenadas por hora.
   *
   * Lanza `FuenteNoDisponible` si la fuente está temporalmente caída (sesión
   * expirada, API con error) — es distinto de "ese día no tiene citas".
   */
  citasDelDia(env: Env, fecha: string): Promise<DiaAgenda>;
}

/** La fuente existe pero ahora mismo no responde. El llamador puede reintentar. */
export class FuenteNoDisponible extends Error {
  constructor(public readonly fuente: string, mensaje: string) {
    super(`fuente ${fuente} no disponible: ${mensaje}`);
    this.name = "FuenteNoDisponible";
  }
}

// ————————————————————— utilidades compartidas —————————————————————

/** "08:20 AM" → minutos desde medianoche. 0 si no se puede parsear. */
export function horaAMinutos(formatted: string): number {
  const m = formatted.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h === 12) h = 0;
  if (m[3].toUpperCase() === "PM") h += 12;
  return h * 60 + min;
}

/** Date (UTC) → "08:20 AM" en hora de Bogotá. */
export function fechaAHora12(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Bogotá = UTC-5, sin horario de verano.
  const bog = new Date(d.getTime() - 5 * 3600 * 1000);
  let h = bog.getUTCHours();
  const min = bog.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")} ${ampm}`;
}

/** "DD-MM-YYYY" → Date UTC a medianoche. null si el formato no calza. */
export function parseFecha(fecha: string): Date | null {
  const m = fecha.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
}

/** "05-08-2026" → "05/08/26" */
export function fechaLegible(fecha: string): string {
  const m = fecha.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[1]}/${m[2]}/${m[3].slice(2)}` : fecha;
}
