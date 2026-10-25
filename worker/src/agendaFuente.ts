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
    // La marca de origen viaja hasta los recordatorios: sin ella, un evento
    // administrativo con el teléfono de una clínica en la descripción se veía
    // igual que una cita del espejo y recibía un WhatsApp de "su cita".
    origen: typeof c.extra?.origen === "string" ? c.extra.origen : undefined,
    telefonoFuente: typeof c.extra?.telefonoFuente === "string" ? c.extra.telefonoFuente : undefined,
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
    const activas = raw
      .filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime)
      // Vienen del portal de citas: son pacientes por definición. Se marca
      // para que esCitaDePaciente no las trate como eventos hechos a mano.
      .map((bk) => ({ ...bk, origen: "bukeala" }));
    return { bookings: activas, fuente: "bukeala" };
  } catch (e) {
    errores.push(`bukeala: ${(e as Error).message}`);
  }

  return { bookings: [], fuente: "ninguna", error: errores.join(" · ") };
}

/** Resultado de la decisión "¿esta cita es de un paciente?". */
export interface DecisionPaciente {
  ok: boolean;
  /** Por qué. Va al log del cron: nunca lleva teléfonos ni cédulas. */
  motivo: string;
}

/**
 * ¿La cita es IDENTIFICABLEMENTE de un paciente? Solo entonces puede salir un
 * recordatorio automático.
 *
 * POR QUÉ: en sep-2026 eventos administrativos creados a mano en Calendar
 * ("Agenda de consultas", "CITAS EXTRAS CLÍNICA COLOMBIA") recibieron un
 * recordatorio de cita porque su descripción traía el celular de una clínica,
 * y fuentes/gcal.ts rescata cualquier celular suelto como teléfono. Tener un
 * número no prueba que haya un paciente detrás.
 *
 * Regla:
 *   (a) origen "bukeala" (espejo o respaldo directo del portal) o "secretaria"
 *       (registrada por el equipo por WhatsApp): paciente, porque esos dos
 *       flujos solo crean eventos de citas reales.
 *   (b) cualquier otro origen (evento a mano, o sin marca): solo si trae
 *       cédula Y un teléfono ETIQUETADO (tel:/cel:... o la línea del 📞). Un
 *       número suelto no basta: es justo lo que traen los eventos
 *       administrativos.
 *
 * "Cédula" quiere decir un número de documento (cedulaDeCita), no cualquier
 * texto después de "Doc:"/"Id:"/"Cédula:": un evento administrativo con
 * "Doc: Dra. Ficticia" o "Cédula: pendiente" junto al celular etiquetado de
 * la clínica pasaba la regla y recibía el recordatorio.
 *
 * Pura a propósito (sin env, sin I/O): se prueba sola y no puede fallar por
 * KV. El filtro de "número del equipo" va aparte, en destinoDeRecordatorio,
 * porque depende del teléfono final (que puede salir del directorio) y de env.
 */
export function esCitaDePaciente(bk: AgendaBookingDoc): DecisionPaciente {
  const origen = (bk.origen ?? "").trim().toLowerCase();
  if (origen === "bukeala") return { ok: true, motivo: "origen bukeala (portal de citas)" };
  if (origen === "secretaria") return { ok: true, motivo: "origen secretaria (registrada por el equipo)" };

  // Sin marca conocida se trata como hecho a mano: tiene que probar que es un
  // paciente. Así un origen nuevo o mal escrito falla hacia NO escribir.
  const quien = origen || "sin origen";
  const tieneCedula = cedulaDeCita(bk.identification) !== "";
  // El motivo distingue "no escribieron cédula" de "escribieron algo que no
  // es una cédula", sin copiar ese texto al log (puede ser un nombre).
  const sinCedula = (bk.identification ?? "").trim()
    ? "sin cédula válida (el documento no trae un número)"
    : "sin cédula";
  const fuenteTel = bk.telefonoFuente ?? "";
  const telEtiquetado = fuenteTel === "etiqueta" || fuenteTel === "emoji";
  const comoTel = fuenteTel === "suelto" ? "teléfono suelto (sin etiqueta)" : "sin teléfono etiquetado";

  if (!tieneCedula && !telEtiquetado) return { ok: false, motivo: `evento ${quien} ${sinCedula} y ${comoTel}` };
  if (!tieneCedula) return { ok: false, motivo: `evento ${quien} ${sinCedula}` };
  if (!telEtiquetado) return { ok: false, motivo: `evento ${quien} con cédula pero ${comoTel}` };
  return { ok: true, motivo: `evento ${quien} con cédula y teléfono etiquetado` };
}

/**
 * El número de documento de una cita: la primera tira de al menos 5 dígitos,
 * aceptando puntos o comas de miles ("1.000.000.002"). "" si no hay.
 *
 * POR QUÉ no basta con "no vacío": fuentes/gcal.ts guarda crudo lo que va
 * después de "cc:", "doc:", "id:"…, y eso puede ser "Dra. Ficticia",
 * "pendiente" o "1000000002 - Tel: 300…" (todo en una línea). Lo primero no
 * es una cédula; lo último sí, pero quitarle todo lo que no es dígito pegaba
 * el teléfono a la cédula y la búsqueda en el directorio fallaba. 5 dígitos
 * es el mismo mínimo que exige el registro de POP CUC (popCuc.ts).
 */
export function cedulaDeCita(identification?: string): string {
  const s = (identification ?? "").replace(/(\d)[.,](?=\d)/g, "$1");
  return s.match(/\d{5,}/)?.[0] ?? "";
}

/** "573001234567" -> "...4567". Para logs: identifica sin exponer el número. */
export function enmascararTel(tel: string): string {
  const d = (tel ?? "").replace(/\D/g, "");
  return d.length > 4 ? `...${d.slice(-4)}` : "...";
}

/** A quién mandarle el recordatorio automático de una cita, o por qué no. */
export interface DestinoRecordatorio {
  /** E.164 sin "+". "" = NO enviar. */
  telefono: string;
  motivo: string;
}

/**
 * Único punto de decisión de los recordatorios automáticos (reminderCron y
 * eveningReminder). Antes cada cron resolvía el teléfono por su cuenta y le
 * escribía a cualquiera que tuviera uno; ahora, en orden:
 *   1. esCitaDePaciente: si no es identificablemente un paciente, nada.
 *   2. teléfono: del evento (si vino etiquetado o de la línea del 📞; un
 *      número suelto no cuenta), del directorio por cédula, o de los campos
 *      phone/customerPhone que puede traer Bukeala.
 *   3. nunca a un número del equipo (doctor, secretarias): un recordatorio
 *      "de su cita" al Dr. o a Laura es ruido, y además deja un
 *      wa:pendingConfirm apuntando a ellos.
 */
export async function destinoDeRecordatorio(
  env: Env,
  bk: AgendaBookingDoc,
  dir?: Record<string, { telefono?: string; email?: string }>,
): Promise<DestinoRecordatorio> {
  const decision = esCitaDePaciente(bk);
  if (!decision.ok) return { telefono: "", motivo: `no es paciente: ${decision.motivo}` };

  const { normalizeColombianPhone } = await import("./whatsapp");
  const telefono =
    (await telefonoDeCita(env, bk, dir)) || normalizeColombianPhone(telefonoSecundario(bk));
  if (!telefono || telefono.length < 10) {
    // Si el único número del evento era suelto se dice: Laura lo ve en la
    // agenda y puede llamar, pero el bot no le escribe solo.
    const motivo =
      bk.telefonoFuente === "suelto"
        ? "sin teléfono del paciente (el único número del evento es suelto, sin etiqueta)"
        : "sin teléfono";
    return { telefono: "", motivo };
  }

  const { esNumeroDelEquipo } = await import("./pacientesContacto");
  if (esNumeroDelEquipo(env, telefono)) {
    return { telefono: "", motivo: `número del equipo (${enmascararTel(telefono)})` };
  }
  return { telefono, motivo: decision.motivo };
}

/** phone / customerPhone: campos que puede traer una cita cruda de Bukeala. */
function telefonoSecundario(bk: AgendaBookingDoc): string {
  if (typeof bk.phone === "string" && bk.phone.trim()) return bk.phone.trim();
  if (typeof bk.customerPhone === "string" && bk.customerPhone.trim()) return bk.customerPhone.trim();
  return "";
}

/**
 * Teléfono utilizable de una cita, ya normalizado a formato Colombia.
 * Busca en la cita y, si no hay, en el directorio propio por cédula.
 *
 * Devuelve "" si no hay ninguno, y eso significa NO MANDAR nada. También
 * devuelve "" si la cita no es identificablemente de un paciente
 * (esCitaDePaciente): tener un número no basta, un evento administrativo
 * puede traer el de una clínica. Para ENVIAR se usa destinoDeRecordatorio,
 * que además da el motivo y filtra los números del equipo.
 *
 * Un número SUELTO del evento nunca sirve de destino, sea cual sea el origen.
 * Un espejo sin teléfono en el directorio escribe la línea del 📞 vacía y
 * debajo el comentario de Bukeala (📝 "Remitido por clínica X, confirmar al
 * 300…"): fuentes/gcal.ts rescata ese número para que Laura lo vea, pero es
 * de un tercero, y el recordatorio "de su cita" le llegaba a la clínica (el
 * incidente de sep-2026 por otra puerta). En ese caso se sigue al directorio
 * por cédula. cellPhone no se toca: la agenda lo sigue mostrando.
 */
export async function telefonoDeCita(
  env: Env,
  bk: AgendaBookingDoc,
  dir?: Record<string, { telefono?: string; email?: string }>,
): Promise<string> {
  if (!esCitaDePaciente(bk).ok) return "";
  const { normalizeColombianPhone } = await import("./whatsapp");

  const directo =
    typeof bk.cellPhone === "string"
      ? bk.cellPhone
      : (bk.cellPhone as { phoneNumber?: string } | null)?.phoneNumber ?? "";
  if (directo && bk.telefonoFuente !== "suelto") {
    const n = normalizeColombianPhone(directo);
    if (n) return n;
  }

  const cc = cedulaDeCita(bk.identification);
  if (!cc) return "";
  const delDir = dir?.[cc]?.telefono;
  if (delDir) return normalizeColombianPhone(delDir) || "";

  const { getContacto } = await import("./pacientesContacto");
  const ct = await getContacto(env, cc);
  return ct?.telefono ? normalizeColombianPhone(ct.telefono) || "" : "";
}
