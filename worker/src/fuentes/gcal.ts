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

/**
 * Valor de una linea que empieza con un emoji, sin "etiqueta:".
 * El espejo (cron/espejoCalendar.ts) escribe asi: "\u{1F4DE} +573106197751",
 * "\u{1FAAA} CC 63438331", "✉️ ana@correo.com". Sin esto el telefono
 * del directorio se perdia al pasar por Calendar y la agenda de Laura decia
 * "sin telefono" teniendolo.
 *
 * El patrón va con String.raw: en un template normal "\s" se vuelve una "s"
 * literal y el regex quedaba `^s*📞️?s*(.+)$`, que no lee una línea con
 * sangría (texto copiado de otro evento). Desde que esta línea decide si sale
 * un recordatorio (esCitaDePaciente), eso dejaba sin aviso a un paciente real.
 * Solo espacios horizontales: con "\s" el patrón saltaba a la línea siguiente
 * cuando la del emoji venía vacía y tomaba otro dato como cédula o teléfono.
 */
function campoEmoji(desc: string, emoji: string): string {
  const re = new RegExp(String.raw`^[ \t\u00A0]*${emoji}\uFE0F?[ \t\u00A0]*(.+)$`, "mu");
  const m = desc.match(re);
  if (!m) return "";
  const v = m[1].trim();
  // El espejo escribe un texto explicito cuando no tiene el dato.
  return /^sin (tel|email|documento)/i.test(v) ? "" : v;
}

/**
 * Busca "etiqueta: valor" en la descripción, probando varios sinónimos.
 * El valor tiene que ir en la MISMA línea: con "\s*" después de los dos
 * puntos, una "Cédula:" vacía se tragaba la línea de abajo ("Cel: 300…") y
 * el celular de una clínica pasaba por cédula.
 */
function campo(desc: string, alias: string[]): string {
  for (const a of alias) {
    const re = new RegExp(String.raw`^[ \t\u00A0]*${a}[ \t\u00A0]*[:=][ \t\u00A0]*(.+)$`, "im");
    const m = desc.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

/** Entidades HTML que el editor de Calendar mete en la descripción. */
function decodificarEntidades(s: string): string {
  const cp = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => cp(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => cp(Number(d)))
    // &amp; al final: "&amp;lt;" es el texto "&lt;", no un "<".
    .replace(/&amp;/gi, "&");
}

const ETIQUETA_HTML = /<\/?[a-z][a-z0-9]*\b[^<>]*>/gi;

/**
 * La descripción como texto plano, una cosa por línea.
 *
 * POR QUÉ: el editor web de Google Calendar guarda la descripción en HTML. Lo
 * que el Dr. escribe en dos líneas ("cc: …" y "tel: …") llega como
 * "cc: …<br>tel: …" o "<div>cc: …</div><div>tel: …</div>", y todo este
 * archivo lee por líneas: la etiqueta del teléfono no se reconocía (salía como
 * número suelto) y la cédula traía "<br>tel: …" pegado. Con la regla de
 * recordatorios eso dejaba sin aviso a citas a mano bien escritas.
 *
 * Un texto sin etiquetas HTML ni entidades sale IDÉNTICO: el espejo y el flujo
 * del equipo escriben texto plano y su lectura no cambia.
 */
export function textoPlanoDescripcion(desc: string): string {
  const pareceHtml =
    new RegExp(ETIQUETA_HTML.source, "i").test(desc) || /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(desc);
  if (!pareceHtml) return desc;
  return decodificarEntidades(
    desc
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(ETIQUETA_HTML, ""),
  ).replace(/\u00A0/g, " ");
}

/**
 * Un celular colombiano precedido de su etiqueta en CUALQUIER parte de la
 * línea: "CC: … - Tel: 300…", "Paciente: Ana, tel: 300…", "Tel. 300…",
 * "Cel 300…". campo() solo ve la etiqueta al inicio de la línea y con ":"; lo
 * demás salía como número suelto y la cita a mano, con cédula y teléfono
 * etiquetado, se quedaba sin recordatorio.
 *
 * La etiqueta tiene que ir pegada al número (solo puntuación y espacios en
 * medio, sin cambiar de línea) y no puede ser el final de otra palabra
 * ("Hotel 300…"): así "WhatsApp clínica: 300…" o "Tel. del consultorio 300…"
 * siguen siendo números sueltos.
 */
const TEL_CON_ETIQUETA = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}])(?:tel[eé]fono|tel|celular|cel|whatsapp|wa)\.?[ \t]*[:=#.\-–]?[ \t]*(?:\+?57[ \t\-]*)?(3\d{9})(?!\d)`,
  "imu",
);

/**
 * Quita las líneas de nota libre (📝). En el espejo es el comentario que
 * alguien dejó en Bukeala y en el flujo del equipo la nota de la secretaria:
 * un "cel 300…" ahí puede ser el de la clínica que remite, no el del
 * paciente, así que no cuenta como teléfono etiquetado.
 */
function sinLineasDeNota(desc: string): string {
  return desc
    .split("\n")
    .filter((l) => !/^[ \t\u00A0]*\u{1F4DD}/u.test(l))
    .join("\n");
}

/**
 * Cédula escrita como se escribe en Colombia, SIN dos puntos: "CC 52123456",
 * "C.C. 52.123.456", "Cédula 52123456", "Documento 1020304050".
 *
 * POR QUÉ: campo() exige "etiqueta:" y estas formas quedaban sin cédula. Desde
 * que los recordatorios exigen cédula para una cita hecha a mano
 * (esCitaDePaciente), el Dr. escribía "CC 52123456" —el formato que se le
 * indicó el 25-oct-2026— y la cita se quedaba sin aviso en silencio.
 *
 * Estrecha a propósito: la etiqueta va al inicio de la línea y solo se
 * devuelven DÍGITOS (≥5, con puntos o comas de miles). Nunca captura texto, así
 * que "Documento pendiente" o "Doc Dra. Ficticia" siguen sin cédula.
 */
const CEDULA_SIN_DOS_PUNTOS = new RegExp(
  String.raw`^[ \t ]*(?:c\.?[ \t]?c\.?|c[eé]dula|documento|doc)[ \t]*[:=#.\-]?[ \t]*(\d{1,3}(?:[.,]\d{3})+|\d{5,})(?![\d.,]*\d)`,
  "imu",
);

function cedulaSinDosPuntos(desc: string): string {
  const m = desc.match(CEDULA_SIN_DOS_PUNTOS);
  return m ? m[1].replace(/\D/g, "") : "";
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
        // Todo se lee del texto plano: una descripción editada en la web de
        // Calendar llega en HTML (ver textoPlanoDescripcion).
        const desc = textoPlanoDescripcion(ev.description ?? "");
        const hora = fechaAHora12(ev.start.dateTime);
        // "Maria Perez - control" → paciente "Maria Perez", nota "control"
        const titulo = (ev.summary ?? "").trim();
        const partes = titulo.split(/\s+[-–—]\s+/);
        const paciente = (partes[0] ?? "").trim();
        const notaTitulo = partes.slice(1).join(" - ").trim();

        // Se registra CÓMO salió el teléfono, no solo cuál es. Una etiqueta
        // ("tel:") o la línea 📞 son alguien diciendo "este es el celular del
        // paciente"; un número suelto puede ser el de la clínica dentro de un
        // evento administrativo ("Agenda de consultas", sep-2026) y no basta
        // para escribirle solo a nadie. `telefono` se sigue llenando igual —
        // Laura lo necesita para llamar —; la decisión de ENVIAR la toma
        // esCitaDePaciente (agendaFuente.ts) con este dato.
        let telefonoFuente: "etiqueta" | "emoji" | "suelto" | "" = "";
        let telefono = normalizarTel(campo(desc, ["tel", "tel[eé]fono", "cel", "celular", "whatsapp", "wa"]));
        if (telefono) telefonoFuente = "etiqueta";
        if (!telefono) {
          telefono = normalizarTel(campoEmoji(desc, "\u{1F4DE}"));
          if (telefono) telefonoFuente = "emoji";
        }
        if (!telefono) {
          // Etiqueta en medio de la línea ("CC: … - Tel: 300…", "Cel 300…").
          // Fuera de las notas 📝: lo que alguien escribió ahí no es una
          // declaración de cuál es el celular del paciente.
          const etiquetado = sinLineasDeNota(desc).match(TEL_CON_ETIQUETA);
          if (etiquetado) telefono = normalizarTel(etiquetado[1]);
          if (telefono) telefonoFuente = "etiqueta";
        }
        if (!telefono) {
          // Sin etiqueta: un celular colombiano, con o sin el 57 delante.
          const suelto = desc.match(/(?:\+?57)?\s*(3\d{9})(?!\d)/);
          if (suelto) telefono = normalizarTel(suelto[1]);
          if (telefono) telefonoFuente = "suelto";
        }
        // Quién creó el evento. El espejo de Bukeala marca "bukeala" y el flujo
        // del equipo por WhatsApp "secretaria" (extendedProperties.private, que
        // events.list devuelve por defecto). Un evento hecho a mano en Calendar
        // no trae nada: queda "manual" y tiene que demostrar que es un paciente.
        const origen = ev.extendedProperties?.private?.origen || "manual";
        // "\u{1FAAA} CC 63438331" -> nos quedamos con los digitos.
        const cc =
          campo(desc, ["cc", "c[eé]dula", "documento", "doc", "id"]) ||
          campoEmoji(desc, "\u{1FAAA}").replace(/[^\d]/g, "") ||
          cedulaSinDosPuntos(desc);
        const email = campo(desc, ["email", "correo", "mail"]) || campoEmoji(desc, "✉");
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
          extra: { ubicacion: ev.location ?? null, calendarId: env.GCAL_CALENDAR_ID, origen, telefonoFuente },
        } satisfies Cita;
      })
      .sort((a, b) => a.horaMin - b.horaMin);

    return { fecha, fechaLegible: fechaLegible(fecha), citas };
  },
};
