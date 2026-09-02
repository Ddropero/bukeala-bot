/**
 * Directorio de contacto de pacientes: cédula → teléfono / email.
 *
 * POR QUÉ EXISTE
 * Bukeala NO devuelve el teléfono ni el email del paciente. Está probado
 * (31/jul/2026): la ficha que entrega tras seleccionar al paciente trae solo
 * tipo de documento, identificación, sexo, edad, fecha de nacimiento y plan.
 * El flag `isValidColombianCellPhone` de la agenda delata que Bukeala SÍ los
 * tiene, pero no los expone.
 *
 * Como la agenda de la secretaria existe para LLAMAR a los pacientes, sin
 * teléfono no sirve. Así que el sistema arma su propio directorio con los datos
 * que ya pasan por él:
 *
 *   - el paciente escribe por WhatsApp y da su cédula → cédula + su número
 *   - una cita agendada por el bot pide email y celular al paciente
 *   - un evento de Google Calendar los trae en la descripción
 *
 * Un paciente que agendó DIRECTO por Colsanitas y nunca escribió no va a estar
 * aquí, y eso hay que decirlo en la agenda en vez de dejar el campo vacío: la
 * secretaria necesita saber a quién le toca buscar el número a mano.
 *
 * Almacenamiento: una llave por cédula (`paciente:contacto:{cedula}`), sin
 * tope. La lista `recent:patients` que ya existía guarda solo 15 y se va
 * rotando — sirve como semilla, no como directorio.
 */
import type { Env } from "./env";

export interface ContactoPaciente {
  cedula: string;
  telefono?: string;
  email?: string;
  nombre?: string;
  /** De dónde salió el dato, para poder auditar y priorizar. */
  fuente: "whatsapp" | "agendamiento" | "gcal" | "manual";
  /** ISO. Si hay dos datos, gana el más nuevo. */
  actualizado: string;
}

const clave = (cedula: string) => `paciente:contacto:${cedula.replace(/\D/g, "")}`;
const TTL = 60 * 60 * 24 * 365 * 2; // 2 años

/** Normaliza a E.164 colombiano sin "+". Devuelve "" si no parece teléfono. */
function normalizarTel(raw?: string): string {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("57") && d.length >= 12) return d;
  if (d.length === 10) return "57" + d;
  return d.length >= 10 ? d : "";
}

/**
 * ¿Este número es del EQUIPO (doctor, secretaria) y no de un paciente?
 *
 * Importa mucho: `wa:patientCtx:{tel}` guarda "el teléfono que estaba
 * chateando" → "la cédula que consultó". Cuando el doctor consulta la cédula de
 * un paciente desde su propio WhatsApp, sin este filtro el directorio concluye
 * que ese teléfono es del paciente — y la secretaria termina llamando al doctor
 * creyendo que llama a la paciente. Pasó en la primera siembra.
 *
 * Exportada porque el webhook de WhatsApp usa EXACTAMENTE este criterio para
 * desviar a Laura y al Dr. a su propio flujo (waEquipoFlow.ts): un solo sitio
 * decide quién es "equipo", así no se desalinean.
 */
export function esNumeroDelEquipo(env: Env, tel: string): boolean {
  const d = (tel ?? "").replace(/\D/g, "");
  if (!d) return false;
  const propios = [
    (env as any).DOCTOR_WHATSAPP_NUMBER ?? "",
    ...String((env as any).SECRETARY_WHATSAPP_NUMBERS ?? "").split(","),
    (env as any).WA_PHONE_ID ?? "", // por si acaso
  ]
    .map((x) => String(x).replace(/\D/g, ""))
    .filter((x) => x.length >= 10);
  return propios.some((p) => p === d || p.endsWith(d) || d.endsWith(p));
}

/**
 * Mismo guardia que arriba, pero para correos. Hizo falta el 1-sep-2026: el
 * correo del Dr. (david@davidduque.com) quedó guardado como si fuera de una
 * paciente, porque el contexto de WhatsApp asocia al chat que consulta una
 * cédula. Se compara contra EQUIPO_EMAILS (lista separada por comas, opcional)
 * y contra el dominio del consultorio.
 */
function esEmailDelEquipo(env: Env, email: string): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  const lista = String((env as any).EQUIPO_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (lista.includes(e)) return true;
  const dominio = e.split("@")[1] ?? "";
  return dominio === "davidduque.com";
}

export async function getContacto(env: Env, cedula: string): Promise<ContactoPaciente | null> {
  if (!cedula) return null;
  try {
    const raw = await env.STATE.get(clave(cedula));
    return raw ? (JSON.parse(raw) as ContactoPaciente) : null;
  } catch {
    return null;
  }
}

/**
 * Guarda o completa el contacto. NO borra lo que ya había: si llega un registro
 * sin email pero el guardado sí tenía, se conserva. Así un dato bueno no se
 * pierde porque una fuente posterior venga incompleta.
 */
export async function guardarContacto(
  env: Env,
  datos: { cedula: string; telefono?: string; email?: string; nombre?: string; fuente: ContactoPaciente["fuente"] },
): Promise<void> {
  const cedula = (datos.cedula ?? "").replace(/\D/g, "");
  if (!cedula) return;
  let tel = normalizarTel(datos.telefono);
  // Nunca registrar un número del equipo como si fuera del paciente.
  if (tel && esNumeroDelEquipo(env, tel)) {
    console.log(`[contactos] ${cedula}: descarto tel del equipo (no es del paciente)`);
    tel = "";
  }
  let email = (datos.email ?? "").includes("@") ? datos.email!.trim() : "";
  // Nunca registrar un correo del equipo como si fuera del paciente.
  if (email && esEmailDelEquipo(env, email)) {
    console.log(`[contactos] ${cedula}: descarto email del equipo (no es del paciente)`);
    email = "";
  }
  const nombre = (datos.nombre ?? "").trim();
  if (!tel && !email && !nombre) return; // nada que guardar

  try {
    const previo = await getContacto(env, cedula);
    const merged: ContactoPaciente = {
      cedula,
      telefono: tel || previo?.telefono,
      email: email || previo?.email,
      nombre: nombre || previo?.nombre,
      fuente: datos.fuente,
      actualizado: new Date().toISOString(),
    };
    await env.STATE.put(clave(cedula), JSON.stringify(merged), { expirationTtl: TTL });
    console.log(`[contactos] guardado ${cedula} (${datos.fuente}) tel=${merged.telefono ? "sí" : "no"} email=${merged.email ? "sí" : "no"}`);
  } catch (e) {
    console.log("[contactos] guardar falló:", (e as Error).message);
  }
}

/**
 * Cosecha el EMAIL del paciente desde Bukeala.
 *
 * Único dato de contacto que Bukeala sí deja ver, y solo en la pantalla de "mis
 * citas" del paciente (tras seleccionarlo). Probado el 31/jul/2026: apareció en
 * 1 de 4 pacientes — o sea, solo cuando el paciente lo tiene registrado. El
 * TELÉFONO no aparece en ninguna pantalla (agenda, ficha, ni mis citas).
 *
 * OJO: `selectCustomer` cambia el paciente seleccionado en la sesión del
 * backoffice. Llamarlo en lote está bien para un cron, pero no en medio de un
 * flujo de agendamiento en curso.
 */
export async function cosecharEmail(
  env: Env,
  cedula: string,
  idTypeNum = "1",
): Promise<string> {
  try {
    const { Bukeala } = await import("./bukeala");
    const b = new Bukeala(env);
    await (await b.selectCustomer(idTypeNum, cedula)).text().catch(() => "");
    const res = await b.myBookings(false);
    const html = await res.text();
    const candidatos = [...new Set(html.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])].filter(
      // Ruido fijo de la plantilla del portal + el correo del propio consultorio.
      (e) => !/tuscitasmedicas|colsanitas|keralty|w3\.org|schema|googleapis|hbritanico|davidduque/i.test(e),
    );
    return candidatos[0] ?? "";
  } catch (e) {
    console.log(`[contactos] cosechar email ${cedula} falló:`, (e as Error).message);
    return "";
  }
}

/**
 * Para las cédulas SIN email en el directorio, intenta cosecharlo de Bukeala.
 * Secuencial a propósito (cada paciente son 2 llamadas al portal) y con tope,
 * para no alargar un cron ni castigar la sesión.
 */
export async function completarEmailsFaltantes(
  env: Env,
  cedulas: string[],
  tope = 12,
): Promise<number> {
  let nuevos = 0;
  const pendientes: string[] = [];
  for (const raw of [...new Set(cedulas.map((c) => (c ?? "").replace(/\D/g, "")).filter(Boolean))]) {
    const actual = await getContacto(env, raw);
    if (!actual?.email) pendientes.push(raw);
  }
  for (const cc of pendientes.slice(0, tope)) {
    const email = await cosecharEmail(env, cc);
    if (email) {
      await guardarContacto(env, { cedula: cc, email, fuente: "manual" });
      nuevos++;
    }
  }
  console.log(`[contactos] emails cosechados: ${nuevos}/${pendientes.length} pendientes`);
  return nuevos;
}

/** Busca varias cédulas de una. Devuelve un mapa cédula → contacto. */
export async function getContactos(
  env: Env,
  cedulas: string[],
): Promise<Record<string, ContactoPaciente>> {
  const out: Record<string, ContactoPaciente> = {};
  await Promise.all(
    [...new Set(cedulas.map((c) => (c ?? "").replace(/\D/g, "")).filter(Boolean))].map(async (cc) => {
      const c = await getContacto(env, cc);
      if (c) out[cc] = c;
    }),
  );
  return out;
}

/**
 * Siembra el directorio con lo que ya está en KV:
 *   - `recent:patients` (trae email y teléfono de los agendados por el bot)
 *   - `wa:patientCtx:*` / `ig:patientCtx:*` (cédula ↔ número de quien escribió)
 *
 * Idempotente: se puede correr las veces que sea.
 */
export async function backfillContactos(env: Env): Promise<{ desdeRecientes: number; desdeChats: number }> {
  let desdeRecientes = 0;
  let desdeChats = 0;

  try {
    const raw = await env.STATE.get("recent:patients");
    const lista = raw ? (JSON.parse(raw) as any[]) : [];
    for (const p of lista) {
      if (!p?.identification) continue;
      if (!p.phone && !p.email) continue;
      await guardarContacto(env, {
        cedula: p.identification,
        telefono: p.phone,
        email: p.email,
        nombre: p.name,
        fuente: "agendamiento",
      });
      desdeRecientes++;
    }
  } catch (e) {
    console.log("[contactos] backfill recientes falló:", (e as Error).message);
  }

  // El número del paciente es la ÚLTIMA parte de la llave: wa:patientCtx:{tel}
  for (const prefix of ["wa:patientCtx:", "ig:patientCtx:"]) {
    try {
      let cursor: string | undefined;
      do {
        const res: any = await env.STATE.list({ prefix, cursor });
        for (const k of res.keys ?? []) {
          const tel = k.name.slice(prefix.length);
          const raw = await env.STATE.get(k.name);
          if (!raw) continue;
          try {
            const ctx = JSON.parse(raw);
            if (!ctx?.cedula) continue;
            await guardarContacto(env, {
              cedula: ctx.cedula,
              // En Instagram el "tel" de la llave es un id de IG, no un número.
              telefono: prefix.startsWith("wa:") ? tel : undefined,
              email: ctx.email,
              nombre: ctx.nombre ?? ctx.name,
              fuente: "whatsapp",
            });
            desdeChats++;
          } catch { /* siguiente */ }
        }
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);
    } catch (e) {
      console.log(`[contactos] backfill ${prefix} falló:`, (e as Error).message);
    }
  }

  console.log(`[contactos] backfill: ${desdeRecientes} de recientes, ${desdeChats} de chats`);
  return { desdeRecientes, desdeChats };
}
