/**
 * Search-by-name module — buscar paciente por nombre/apellido en el backoffice
 * de Bukeala (Colsanitas Colombia) para Telegram bot.
 *
 * STATUS: STUB (pending HAR capture).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INVESTIGATION SUMMARY
 * ─────────────────────────────────────────────────────────────────────────────
 * Investigué los siguientes archivos en busca del endpoint para "buscar
 * paciente por nombre" en el backoffice (appoint.tuscitasmedicas.com):
 *
 *   • uploads/1.har                     (~3.9 MB — login flow CAS, no customer search)
 *   • uploads/2.har                     (~5.1 MB — booking flow completo)
 *   • uploads/appoint.tuscitasmedicas.com.har  (~120 KB — solo /findCustomer/validate)
 *   • uploads/appointAssignBooking.js   (76 KB — JS frontend de asignación)
 *   • uploads/debug-responses/*.html    (myBookings, findAvailability)
 *   • uploads/debug-responses/*.json    (loadComponents, doSearch, etc.)
 *   • uploads/dump/myBookings.html
 *   • dumps/token_2.har/*.txt           (dump completo del flujo capturado)
 *
 * Patrones buscados (case-insensitive):
 *   • URLs con `?pattern=`, `?name=`, `?nombre=`, `?search=`, `?query=`,
 *     `?searchTerm=`, `?namePattern=`, `?searchPattern=`, `?customerPattern=`
 *   • Endpoints `/findCustomer/search`, `/customer/search`, `/admin/customer/...`,
 *     `/admin/patient/...`, `/customers/search`, `/patients/search`,
 *     `/customer/list`, `/customer/find`, `/findByName`, `/findByPattern`
 *   • Funciones JS `searchCustomer`, `searchPatient`, `findByName`,
 *     `autocomplete`, `customerByName`, `patientByName`, `nameSearch`,
 *     `getSearch`, `loadCustomer`, `customersByName`, `patientsByName`
 *
 * Hallazgos:
 *   • El ÚNICO endpoint relacionado con paciente que aparece capturado es:
 *       GET /keraltyadscritos/findCustomer/validate/{idType}/{identification}
 *     y el "select":
 *       GET /keraltyadscritos/findCustomer/{idType}/{identification}?customerGenderCode=-
 *
 *   • Existe un script `appointFindCustomer.js` (referenciado en el HAR como
 *     initiator del fetch de /findCustomer/validate) con función `getSearch`
 *     en línea 110, pero el contenido del .js NO está dentro de los HARs y
 *     todas las trazas de getSearch que sí aparecen apuntan únicamente al
 *     endpoint /findCustomer/validate/{idType}/{id} — es decir, el "search"
 *     que captura el HAR es la validación de cédula, no una búsqueda por nombre.
 *
 *   • La página /findAvailability NO contiene un input de búsqueda de paciente
 *     por nombre — solo un input `areaName` (nombre de PROFESIONAL, no paciente).
 *     El menú lateral solo expone: Inicio (findAvailability), Mi agenda
 *     (myBookings), Historial.
 *
 *   • Los i18n keys hallados sí sugieren que la funcionalidad EXISTE en
 *     algún lado del backoffice ("elearning.customers.search.title" =
 *     "Búsqueda de Pacientes", "customers.search.error" = "Ingrese tres o
 *     más caracteres", "partners.reassignConfig.searchCustomer.empty" = "No
 *     se encontraron pacientes "), pero el endpoint que la sirve NO está
 *     capturado en ningún HAR disponible.
 *
 * Conclusión:
 *   No tengo evidencia suficiente para implementar la llamada real. Necesito
 *   un HAR nuevo grabando exactamente la acción de "buscar paciente por
 *   nombre" en el backoffice (probablemente desde una pantalla
 *   admin/elearning/reassign que el HAR existente no cubre).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRATION NOTES (para cuando llegue el HAR)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Cuando se identifique el endpoint real (ejemplo hipotético:
 *   GET /keraltyadscritos/findCustomer/searchByName?pattern=PEPITO&_=...),
 * añadir en bukeala.ts un método como:
 *
 *     searchCustomersByName(pattern: string): Promise<Response> {
 *       const qs = new URLSearchParams({ pattern, _: Date.now().toString() });
 *       return this.req(`/findCustomer/searchByName?${qs}`);
 *     }
 *
 * y luego reemplazar el cuerpo del stub `performSearch()` de abajo por:
 *
 *     const bk = new Bukeala(env);
 *     const res = await bk.searchCustomersByName(namePattern);
 *     const data = await res.json();
 *     // Asumiendo respuesta: [{ name, identification, identificationTypeShortCode }, ...]
 *     return data.map(c => ({ name: c.name, idType: mapTypeToCode(c.identificationTypeShortCode), id: c.identification }));
 *
 * En telegram.ts, enrutar el comando así:
 *
 *     // Texto del usuario (después de "/buscar_nombre PEPITO" o similar):
 *     if (text.startsWith("/buscar_nombre ")) {
 *       const pattern = text.slice("/buscar_nombre ".length).trim();
 *       const { searchByName } = await import("./commands/searchByName");
 *       return searchByName(env, chatId, pattern);
 *     }
 *
 * El callback_data de cada botón usa el formato `recent:<idType>:<identification>`
 * para integrarse con la feature 8 (recent customers) que reusará el mismo handler.
 */
import type { Env } from "../env";

// ====================================================================
// Telegram helpers — duplicados de telegram.ts para mantener este módulo
// independiente de archivos compartidos (per integration constraints).
// ====================================================================
const TG = (token: string) => `https://api.telegram.org/bot${token}`;

async function tg(env: Env, method: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(
  env: Env,
  chat_id: string,
  text: string,
  extra: object = {},
): Promise<unknown> {
  return tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
}

// ====================================================================
// Types
// ====================================================================
type CustomerHit = {
  name: string;
  idType: string;        // e.g. "1" cédula, "8" tarjeta de identidad
  identification: string;
};

type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

const MAX_RESULTS = 8;

// ====================================================================
// Public API
// ====================================================================

/**
 * Busca pacientes en Bukeala por patrón de nombre (o apellido) y envía al
 * usuario un mensaje en Telegram con un inline keyboard de hasta 8 resultados.
 *
 * Cada botón tiene `callback_data = recent:<idType>:<identification>` para
 * compatibilidad con feature 8 (recent customers) — al tocar, debería
 * disparar el flujo de "selectCustomer" usando ese par idType/id.
 *
 * STATUS ACTUAL: stub. Mientras no se capture el HAR del endpoint real, el
 * mensaje le explica al usuario qué necesita grabar.
 */
export async function searchByName(
  env: Env,
  chatId: string,
  namePattern: string,
): Promise<void> {
  const pattern = (namePattern ?? "").trim();

  // Validación mínima de UX (Bukeala mismo dice "Ingrese tres o más caracteres")
  if (pattern.length < 3) {
    await sendMessage(
      env,
      chatId,
      "Ingrese 3 o más caracteres para buscar paciente por nombre.",
    );
    return;
  }

  console.log(`[searchByName] chat=${chatId} pattern="${pattern}"`);

  const hits = await performSearch(env, pattern);

  // STUB MODE — performSearch() retorna `null` mientras el endpoint real no esté.
  if (hits === null) {
    await sendMessage(
      env,
      chatId,
      [
        "🔧 <b>Búsqueda por nombre — pendiente</b>",
        "",
        `Patrón solicitado: <code>${escapeHtml(pattern)}</code>`,
        "",
        "Aún no tengo identificado el endpoint que el backoffice usa para",
        "buscar pacientes por nombre. Necesito que grabes un HAR:",
        "",
        "1. Abre DevTools (F12) → pestaña Network",
        "2. Logueate en el backoffice de Bukeala",
        "3. Ve a la pantalla donde está el input de \"buscar paciente por",
        "   nombre\" (probablemente en sección de Reasignar / Admin /",
        "   Búsqueda de Pacientes — el menú lateral del HAR actual no",
        "   muestra esa opción)",
        "4. Escribe un nombre y dispara la búsqueda",
        "5. Filtra Network por <code>keraltyadscritos</code>",
        "6. Click derecho → \"Save all as HAR with content\"",
        "7. Sube el HAR y avísame",
        "",
        "Lo que ya investigué (no encontrado):",
        "• /findCustomer/search?pattern=...",
        "• /customer/search, /customers/search, /patients/search",
        "• /admin/customer/..., /admin/patient/...",
        "• /findCustomer/searchByName, /findByPattern",
        "",
        "Mientras tanto puedes usar /buscar (por cédula).",
      ].join("\n"),
    );
    return;
  }

  // REAL MODE — cuando performSearch() devuelva resultados.
  if (hits.length === 0) {
    await sendMessage(
      env,
      chatId,
      `No se encontraron pacientes con el patrón <code>${escapeHtml(pattern)}</code>.`,
    );
    return;
  }

  const top = hits.slice(0, MAX_RESULTS);
  const keyboard = buildKeyboard(top);

  const header = top.length < hits.length
    ? `Encontré ${hits.length} pacientes. Mostrando los primeros ${top.length}:`
    : `Encontré ${top.length} paciente${top.length === 1 ? "" : "s"}:`;

  await sendMessage(env, chatId, header, { reply_markup: keyboard });
}

// ====================================================================
// Internals
// ====================================================================

/**
 * Realiza la búsqueda real contra Bukeala. STUB hoy → retorna `null`.
 *
 * Cuando se añada el método correspondiente a `Bukeala`, reemplazar el
 * cuerpo por una llamada del estilo:
 *
 *     const bk = new Bukeala(env);
 *     const res = await bk.searchCustomersByName(pattern);
 *     if (!res.ok) return [];
 *     const data = await res.json();
 *     return parseCustomers(data);
 */
async function performSearch(
  _env: Env,
  _pattern: string,
): Promise<CustomerHit[] | null> {
  // STUB: no endpoint conocido todavía.
  return null;
}

function buildKeyboard(hits: CustomerHit[]): InlineKeyboard {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const h of hits) {
    const safeName = truncate(h.name.trim() || "(sin nombre)", 40);
    const label = `${safeName} — ${h.identification}`;
    rows.push([
      {
        text: truncate(label, 60),
        callback_data: `recent:${h.idType}:${h.identification}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}
