/**
 * Fuente de agenda: Google Calendar.
 *
 * Esta es la fuente que hace vendible el producto fuera de Colsanitas: un
 * cirujano particular lleva su agenda en Calendar y obtiene lo mismo
 * (recordatorios, confirmación por botón, lista de llamadas para la
 * secretaria) sin que nadie toque un portal de terceros ni un captcha.
 *
 * CONVENCIÓN DEL EVENTO — el título y la descripción son la fuente de datos:
 *
 *   Título:  "Maria Perez"  ó  "Maria Perez - control"
 *   Descripción (una cosa por línea, en cualquier orden):
 *     tel: 3001234567
 *     cc: 1020304050
 *     email: maria@correo.com
 *     nota: trae ecografía
 *
 * Se aceptan variantes comunes (`celular`, `teléfono`, `cédula`, `correo`) y,
 * si no hay etiqueta, se rescata cualquier número de 10 dígitos de la
 * descripción como teléfono. Así el médico puede escribir natural sin aprender
 * un formato estricto.
 */
import type { Env } from "../env";
import { listEvents } from "../gcal";
import {
  type Cita,
  type DiaAgenda,
  type FuenteAgenda,
  FuenteNoDisponible,
  fechaAHora12,
  fechaLegible,
  horaAMinutos,
  parseFecha,
} from "./tipos";

/** Busca "etiqueta: valor" en la descripción, probando varios sinónimos. */
function campo(desc: string, alias: string[]): string {
  for (const a of alias) {
    const re = new RegExp(`^\\s*${a}\\s*[:=]\\s*(.+)$`, "im");
    const m = desc.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

/** Deja solo dígitos y normaliza a E.164 colombiano sin "+". */
function normalizarTel(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("57") && d.length >= 12) return d;
  if (d.length === 10) return "57" + d;
  return d;
}

export const fuenteGCal: FuenteAgenda = {
  nombre: "gcal",

  disponible(env: Env): boolean {
    return !!(env.GCAL_SERVICE_ACCOUNT_JSON && env.GCAL_CALENDAR_ID);
  },

  async citasDelDia(env: Env, fecha: string): Promise<DiaAgenda> {
    if (!this.disponible(env)) {
      throw new FuenteNoDisponible("gcal", "faltan GCAL_SERVICE_ACCOUNT_JSON o GCAL_CALENDAR_ID");
    }
    const dia = parseFecha(fecha);
    if (!dia) throw new FuenteNoDisponible("gcal", `fecha inválida: ${fecha}`);

    // El día completo en hora de Bogotá (UTC-5) expresado en instantes UTC.
    const desde = new Date(dia.getTime() + 5 * 3600 * 1000).toISOString();
    const hasta = new Date(dia.getTime() + (24 + 5) * 3600 * 1000).toISOString();

    let eventos;
    try {
      eventos = await listEvents(env, env.GCAL_CALENDAR_ID!, desde, hasta);
    } catch (e) {
      throw new FuenteNoDisponible("gcal", (e as Error).message);
    }

    const citas: Cita[] = eventos
      .filter((ev) => ev.status !== "cancelled")
      // Sin hora de inicio es un evento de día completo: no es una cita.
      .filter((ev) => !!ev.start?.dateTime)
      .map((ev) => {
        const desc = ev.description ?? "";
        const hora = fechaAHora12(ev.start.dateTime);
        // "Maria Perez - control" → paciente "Maria Perez", nota "control"
        const titulo = (ev.summary ?? "").trim();
        const partes = titulo.split(/\s+[-–—]\s+/);
        const paciente = (partes[0] ?? "").trim();
        const notaTitulo = partes.slice(1).join(" - ").trim();

        let telefono = normalizarTel(campo(desc, ["tel", "tel[eé]fono", "cel", "celular", "whatsapp", "wa"]));
        if (!telefono) {
          // Sin etiqueta: cualquier número de 10 dígitos sirve como teléfono.
          const suelto = desc.match(/(?<!\d)(3\d{9})(?!\d)/);
          if (suelto) telefono = normalizarTel(suelto[1]);
        }
        const cc = campo(desc, ["cc", "c[eé]dula", "documento", "doc", "id"]);
        const email = campo(desc, ["email", "correo", "mail"]);
        const nota = campo(desc, ["nota", "notas", "obs", "observaci[oó]n"]);

        // El asistente que confirmó en Calendar cuenta como cita confirmada.
        const acepto = (ev.attendees ?? []).some((a: any) => a?.responseStatus === "accepted");

        return {
          id: ev.id ?? `${ev.start.dateTime}-${paciente}`,
          hora,
          horaFin: ev.end?.dateTime ? fechaAHora12(ev.end.dateTime) : "",
          horaMin: horaAMinutos(hora),
          paciente: paciente || "(sin nombre)",
          documento: cc,
          telefono,
          email,
          estado: acepto ? ("confirmada" as const) : ("pendiente" as const),
          estadoTexto: acepto ? "Confirmada en Calendar" : "Agendada",
          // Si el evento tiene enlace de Meet, es virtual.
          presencial: (ev as any).hangoutLink ? false : null,
          notas: [notaTitulo, nota].filter(Boolean).join(" · "),
          extra: { ubicacion: ev.location ?? null, calendarId: env.GCAL_CALENDAR_ID },
        } satisfies Cita;
      })
      .sort((a, b) => a.horaMin - b.horaMin);

    return { fecha, fechaLegible: fechaLegible(fecha), citas };
  },
};
