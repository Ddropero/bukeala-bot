/**
 * API de lectura de la agenda — para que apps externas (Mayordomo) sepan qué
 * citas hay sin tener que hablar con Bukeala.
 *
 * Toda la parte difícil (sesión, captchas, cookies, el TGC que CAS mata cada
 * ~6h) vive en este Worker; el consumidor solo hace un GET.
 *
 *   GET /api/agenda?token=<CAPTURE_TOKEN>            → hoy
 *   GET /api/agenda?token=..&date=05-08-2026         → un día
 *   GET /api/agenda?token=..&date=05-08-2026&days=3  → ese día y los 2 siguientes
 *
 * OJO — la API de Bukeala NO devuelve teléfono ni email del paciente (solo un
 * flag de que tiene celular válido). Por eso aquí tampoco van: se expone
 * `tieneCelularValido` y nada más, en vez de un campo vacío que engañe.
 */
import type { Context } from "hono";
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MINUTES = -5 * 60;
const MAX_DAYS = 7;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function todayInColombia(): Date {
  const now = new Date();
  return new Date(now.getTime() + COLOMBIA_OFFSET_MINUTES * 60 * 1000);
}

function toDashed(d: Date): string {
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function parseDashed(s: string): Date | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
}

type ApiCita = {
  id: number | string | null;
  hora: string;
  horaFin: string;
  nombre: string;
  paciente: string;
  cedula: string;
  telefono: string;
  email: string;
  estado: string;
  estadoDesc: string;
  plan: string | null;
  presencial: boolean | null;
  codigo: string | null;
  /** "si" | "no" si el paciente respondió al recordatorio; null si no ha respondido. */
  confirmacionWa: "si" | "no" | null;
  /** Bukeala no da el número; solo dice si tiene uno válido. */
  tieneCelularValido: boolean | null;
};

export async function handleApiAgenda(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // ?fuente=bukeala|gcal → capa de fuentes normalizada (ver src/fuentes/).
  // Sin el parámetro se usa el camino histórico de abajo, intacto: así el
  // cambio no puede romper lo que ya consume este endpoint.
  const fuenteParam = c.req.query("fuente");
  if (fuenteParam) return await agendaPorFuente(c, fuenteParam);

  const dateParam = c.req.query("date");
  let start: Date;
  if (dateParam) {
    const parsed = parseDashed(dateParam);
    if (!parsed) return c.json({ error: "date debe ser DD-MM-YYYY" }, 400);
    start = parsed;
  } else {
    start = todayInColombia();
  }

  const daysRaw = parseInt(c.req.query("days") ?? "1", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), MAX_DAYS) : 1;

  const b = new Bukeala(c.env);
  const dias: unknown[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dashed = toDashed(d);
    let bookings: any[] = [];
    let legible = dashed;
    try {
      const res = await b.getAgenda(dashed, AREA_ID, false);
      const json = await res.json<any>().catch(() => null);
      bookings = json?.areas?.[0]?.bookings ?? [];
      legible = json?.defaultDateFormatted ?? dashed;
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        // 503: es temporal — la VM renueva cada ~10 min. Mayordomo puede reintentar.
        return c.json(
          { error: "sesion_bukeala_caida", detalle: "Reintenta en unos minutos; el renovador la levanta solo.", fecha: dashed },
          503,
        );
      }
      return c.json({ error: "bukeala_error", detalle: (e as Error).message, fecha: dashed }, 502);
    }

    const activas = bookings.filter(
      (bk) => !bk?.isCanceled && bk?.stateCode !== "CANCELED" && !bk?.isBusyTime,
    );

    // Directorio propio de contactos (Bukeala no da teléfono/email). Un solo
    // batch para todas las cédulas del día.
    const { getContactos } = await import("../pacientesContacto");
    const dir = await getContactos(c.env, activas.map((bk: any) => bk?.identification ?? ""));

    const citas: ApiCita[] = [];
    for (const bk of activas) {
      const id = bk?.id ?? null;
      let confirmacionWa: "si" | "no" | null = null;
      if (id != null) {
        const v = await c.env.STATE.get(`wa:citaConfirm:${id}`);
        if (v === "si" || v === "no") confirmacionWa = v;
      }
      const tipoDoc = (bk?.identificationTypeShortCode ?? "").trim();
      const numDoc = (bk?.identification ?? "").trim();
      const ct = numDoc ? dir[numDoc.replace(/\D/g, "")] : undefined;
      const nombre = (bk?.name ?? "").trim();
      citas.push({
        id,
        hora: (bk?.startHourFormatted ?? "").trim(),
        horaFin: (bk?.endHourFormatted ?? "").trim(),
        nombre,
        // `paciente` = alias de `nombre`, para que el panel y los clientes nuevos
        // lean el mismo campo venga del path histórico o de la capa de fuentes.
        paciente: nombre,
        cedula: [tipoDoc, numDoc].filter(Boolean).join(" "),
        telefono: ct?.telefono ?? "",
        email: ct?.email ?? "",
        estado: bk?.stateCode ?? "",
        estadoDesc: bk?.stateDesc ?? "",
        plan: bk?.planName ?? null,
        presencial: typeof bk?.isPresential === "boolean" ? bk.isPresential : null,
        codigo: bk?.bookingCode ?? null,
        confirmacionWa,
        tieneCelularValido:
          typeof bk?.isValidColombianCellPhone === "boolean" ? bk.isValidColombianCellPhone : null,
      });
    }

    citas.sort((a, b2) => horaEnMinutos(a.hora) - horaEnMinutos(b2.hora));

    dias.push({
      fecha: dashed,
      fechaLegible: legible,
      total: citas.length,
      confirmadas: citas.filter((x) => x.confirmacionWa === "si").length,
      sinConfirmar: citas.filter((x) => x.confirmacionWa === null).length,
      citas,
    });
  }

  return c.json({ ok: true, dias });
}

/**
 * Misma respuesta, pero leyendo de una FuenteAgenda. Es el camino que usarán
 * los clientes nuevos: el mismo JSON venga de Bukeala o de Google Calendar.
 */
async function agendaPorFuente(c: Context<{ Bindings: Env }>, nombre: string) {
  const { resolverFuente, fuentesDisponibles, FuenteNoDisponible } = await import("../fuentes");
  const fuente = resolverFuente(c.env, nombre);
  if (!fuente) {
    return c.json(
      { error: "fuente_no_disponible", pedida: nombre, disponibles: fuentesDisponibles(c.env) },
      400,
    );
  }

  const dateParam = c.req.query("date");
  let start: Date;
  if (dateParam) {
    const parsed = parseDashed(dateParam);
    if (!parsed) return c.json({ error: "date debe ser DD-MM-YYYY" }, 400);
    start = parsed;
  } else {
    start = todayInColombia();
  }
  const daysRaw = parseInt(c.req.query("days") ?? "1", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), MAX_DAYS) : 1;

  const dias: unknown[] = [];
  for (let i = 0; i < days; i++) {
    const dashed = toDashed(new Date(start.getTime() + i * 86400000));
    try {
      const dia = await fuente.citasDelDia(c.env, dashed);
      // La confirmación por WhatsApp la guarda este Worker, no la fuente.
      const citas = [] as any[];
      for (const cita of dia.citas) {
        let confirmacionWa: "si" | "no" | null = null;
        if (cita.id) {
          const v = await c.env.STATE.get(`wa:citaConfirm:${cita.id}`);
          if (v === "si" || v === "no") confirmacionWa = v;
        }
        citas.push({ ...cita, confirmacionWa });
      }
      dias.push({
        fecha: dia.fecha,
        fechaLegible: dia.fechaLegible,
        total: citas.length,
        confirmadas: citas.filter((x) => x.confirmacionWa === "si" || x.estado === "confirmada").length,
        sinConfirmar: citas.filter((x) => x.confirmacionWa === null && x.estado !== "confirmada").length,
        citas,
      });
    } catch (e) {
      if (e instanceof FuenteNoDisponible) {
        return c.json({ error: "fuente_caida", fuente: fuente.nombre, detalle: e.message, fecha: dashed }, 503);
      }
      return c.json({ error: "fuente_error", fuente: fuente.nombre, detalle: (e as Error).message }, 502);
    }
  }
  return c.json({ ok: true, fuente: fuente.nombre, dias });
}

/** "08:20 AM" → minutos desde medianoche (para ordenar). */
function horaEnMinutos(formatted: string): number {
  const m = formatted.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h === 12) h = 0;
  if (m[3].toUpperCase() === "PM") h += 12;
  return h * 60 + min;
}
