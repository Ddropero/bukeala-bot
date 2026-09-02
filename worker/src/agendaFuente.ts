/**
 * Lectura de la agenda del día para los crons (Laura, recordatorios).
 *
 * POR QUÉ EXISTE: hasta el 1-sep-2026 los crons leían directo de Bukeala, que
 * solo tiene las citas de Colsanitas. Medido ese día: Bukeala 1 cita vs
 * Calendar 7 en la misma ventana — las cirugías y consultas particulares del
 * Dr. viven en Google Calendar y el sistema no las veía. Como el espejo
 * (cron/espejoCalendar.ts) copia Bukeala → Calendar, **Calendar es la fuente
 * completa**: EPS + particular en un solo lugar, y además no depende de que la
 * sesión de Bukeala esté viva (que se cae cada ~6h por el anti-bot Radware).
 *
 * Devuelve el formato AgendaBookingDoc que ya usan buildAgendaText/Html/Pdf,
 * para no tocar la generación de documentos.
 */
import type { Env } from "./env";
import type { AgendaBookingDoc } from "./agendaDoc";
import type { Cita } from "./fuentes/tipos";

/** Convierte una cita normalizada (venga de Calendar o Bukeala) al formato de documento. */
export function citaABookingDoc(c: Cita): AgendaBookingDoc {
  return {
    id: c.id,
    startHourFormatted: c.hora,
    endHourFormatted: c.horaFin,
    name: c.paciente,
    identification: c.documento || undefined,
    stateCode: c.estado === "confirmada" ? "CONFIRMED" : "BOOKED",
    stateDesc: c.estadoTexto,
    isCanceled: false,
    isBusyTime: false,
    planName: c.notas || undefined,
    cellPhone: c.telefono || undefined,
    email: c.email || undefined,
  };
}

export interface AgendaDelDia {
  bookings: AgendaBookingDoc[];
  /** "gcal" | "bukeala" — de dónde salió, para poder decirlo en el mensaje. */
  fuente: string;
  /** Mensaje de error si NINGUNA fuente respondió. */
  error?: string;
}

/**
 * Lee la agenda de un día. Calendar primero (es la completa); si falla, cae a
 * Bukeala para no dejar al Dr. sin agenda por un problema de Google.
 *
 * @param dashed fecha DD-MM-YYYY
 */
export async function leerAgendaDelDia(env: Env, dashed: string): Promise<AgendaDelDia> {
  const errores: string[] = [];

  // 1) Google Calendar — la fuente completa (incluye el espejo de Bukeala).
  try {
    const { resolverFuente } = await import("./fuentes");
    const gcal = resolverFuente(env, "gcal");
    if (gcal && gcal.disponible(env)) {
      const dia = await gcal.citasDelDia(env, dashed);
      return { bookings: dia.citas.map(citaABookingDoc), fuente: "gcal" };
    }
    errores.push("gcal no configurado");
  } catch (e) {
    errores.push(`gcal: ${(e as Error).message}`);
  }

  // 2) Respaldo: Bukeala directo (solo citas de Colsanitas).
  try {
    const { Bukeala } = await import("./bukeala");
    const b = new Bukeala(env);
    const res = await b.getAgenda(dashed, 1074, /* includeCanceled */ false);
    const json = (await res.json().catch(() => null)) as any;
    const raw = (json?.areas?.[0]?.bookings ?? []) as AgendaBookingDoc[];
    const activas = raw.filter(
      (bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime,
    );
    return { bookings: activas, fuente: "bukeala" };
  } catch (e) {
    errores.push(`bukeala: ${(e as Error).message}`);
  }

  return { bookings: [], fuente: "ninguna", error: errores.join(" · ") };
}

/**
 * Teléfono utilizable de una cita, ya normalizado a formato Colombia.
 * Busca en la cita y, si no hay, en el directorio propio por cédula.
 *
 * Devuelve "" si no hay ninguno — y eso significa NO MANDAR nada. Es el
 * guardia que impide que un evento que no es un paciente ("Cirugía con
 * Vanesa", "Puente Aranda") dispare un WhatsApp a un número equivocado.
 */
export async function telefonoDeCita(
  env: Env,
  bk: AgendaBookingDoc,
  dir?: Record<string, { telefono?: string; email?: string }>,
): Promise<string> {
  const { normalizeColombianPhone } = await import("./whatsapp");

  const directo =
    typeof bk.cellPhone === "string"
      ? bk.cellPhone
      : (bk.cellPhone as { phoneNumber?: string } | null)?.phoneNumber ?? "";
  if (directo) {
    const n = normalizeColombianPhone(directo);
    if (n) return n;
  }

  const cc = (bk.identification ?? "").replace(/\D/g, "");
  if (!cc) return "";
  const delDir = dir?.[cc]?.telefono;
  if (delDir) return normalizeColombianPhone(delDir) || "";

  const { getContacto } = await import("./pacientesContacto");
  const ct = await getContacto(env, cc);
  return ct?.telefono ? normalizeColombianPhone(ct.telefono) || "" : "";
}
