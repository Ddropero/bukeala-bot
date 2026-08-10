/**
 * Fuente de agenda: Bukeala (Colsanitas / Keralty).
 *
 * Envuelve el cliente que ya existe (`../bukeala`) y normaliza su respuesta.
 * No cambia nada del comportamiento actual: es un adaptador.
 *
 * LIMITACIÓN CONOCIDA: la API de agenda de Bukeala NO devuelve teléfono ni
 * email del paciente (solo un flag `isValidColombianCellPhone`). Por eso
 * `telefono` y `email` salen vacíos y el flag va en `extra`. Verificado el
 * 31/jul/2026 inspeccionando la respuesta cruda.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import {
  type Cita,
  type DiaAgenda,
  type EstadoCita,
  type FuenteAgenda,
  FuenteNoDisponible,
  fechaLegible,
  horaAMinutos,
} from "./tipos";

const AREA_ID = 1074;

function mapEstado(stateCode: string): EstadoCita {
  switch (stateCode) {
    case "PENDING":
    case "PENDING_CONFIRMATION":
    case "PENDING_DATA":
    case "PENDING_PAYMENT":
    case "OVER_BOOKING":
      return "pendiente";
    case "CONFIRMED":
      return "confirmada";
    case "ADMITTED":
    case "STARTED":
      return "en_curso";
    case "ENDED":
      return "atendida";
    case "NOT_ASSISTED":
      return "no_asistio";
    case "CANCELED":
      return "cancelada";
    default:
      return "desconocido";
  }
}

export const fuenteBukeala: FuenteAgenda = {
  nombre: "bukeala",

  disponible(env: Env): boolean {
    return !!env.BUKEALA_BASE;
  },

  async citasDelDia(env: Env, fecha: string): Promise<DiaAgenda> {
    const b = new Bukeala(env);
    let bookings: any[] = [];
    let legible = fechaLegible(fecha);
    try {
      const res = await b.getAgenda(fecha, AREA_ID, false);
      const json = await res.json<any>().catch(() => null);
      bookings = json?.areas?.[0]?.bookings ?? [];
      if (json?.defaultDateFormatted) legible = json.defaultDateFormatted;
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        // Temporal: el renovador de la VM la levanta en ~10 min.
        throw new FuenteNoDisponible("bukeala", "sesión expirada");
      }
      throw new FuenteNoDisponible("bukeala", (e as Error).message);
    }

    const citas: Cita[] = bookings
      .filter((bk) => !bk?.isCanceled && bk?.stateCode !== "CANCELED" && !bk?.isBusyTime)
      .map((bk) => {
        const hora = (bk?.startHourFormatted ?? "").trim();
        const tipoDoc = (bk?.identificationTypeShortCode ?? "").trim();
        const numDoc = (bk?.identification ?? "").trim();
        return {
          id: String(bk?.id ?? ""),
          hora,
          horaFin: (bk?.endHourFormatted ?? "").trim(),
          horaMin: horaAMinutos(hora),
          paciente: (bk?.name ?? "").trim(),
          documento: [tipoDoc, numDoc].filter(Boolean).join(" "),
          telefono: "", // Bukeala no lo expone en la agenda
          email: "",
          estado: mapEstado(bk?.stateCode ?? ""),
          estadoTexto: (bk?.stateDesc ?? "").trim(),
          presencial: typeof bk?.isPresential === "boolean" ? bk.isPresential : null,
          notas: (bk?.comment ?? "").trim(),
          extra: {
            plan: bk?.planName ?? null,
            codigo: bk?.bookingCode ?? null,
            tieneCelularValido:
              typeof bk?.isValidColombianCellPhone === "boolean" ? bk.isValidColombianCellPhone : null,
          },
        } satisfies Cita;
      })
      .sort((a, b2) => a.horaMin - b2.horaMin);

    return { fecha, fechaLegible: legible, citas };
  },
};
