import type { Env } from "./env";
import { SessionExpiredError } from "./bukeala";
import { validComponentsResponse, type getRecoveryStatus } from "./sessionRecovery";

type RecoveryStatus = Awaited<ReturnType<typeof getRecoveryStatus>> | null;
type ServiceEvent = { type: string; at: string; via?: string };
const REUSED_SESSION = ["alive", "tgc", "persistent", "persistent-adopted"];

/** Área de agenda del Dr. (la misma que usa /agenda). */
export const AGENDA_AREA_ID = 1074;

/**
 * Hoy en Bogotá como DD-MM-YYYY (formato que pide getAgenda). Bogotá es UTC-5
 * fijo, sin horario de verano, así que basta restar 5 h. Mismo cálculo que
 * agendaConfirmaSesion() en native-host-cloud/autoLogin.js.
 */
export function todayBogotaDashed(now = Date.now()): string {
  const d = new Date(now - 5 * 3600 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/** 200 + JSON que es exactamente `[]` (loadComponents sin paciente seleccionado). */
async function isEmptyComponentsList(response: Response): Promise<boolean> {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("json")) return false;
  try {
    const body: unknown = await response.json();
    return Array.isArray(body) && body.length === 0;
  } catch { return false; }
}

/**
 * La agenda confirma la sesión solo con 200 + JSON con `areas` array. No se
 * exige content-type: se parsea el texto, y un HTML de login no es JSON.
 * Un 302 ni llega aquí: Bukeala.req lo convierte en SessionExpiredError.
 */
async function agendaConfirmsSession(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const body: unknown = JSON.parse((await response.text()).trim());
    return !!body && typeof body === "object" && Array.isArray((body as { areas?: unknown }).areas);
  } catch { return false; }
}

/**
 * `inconclusive: true` = no hubo veredicto: Bukeala respondió 5xx (en
 * componentes o en la agenda) o la carga lanzó algo que NO es
 * SessionExpiredError (red, proxy DO). alive sigue en false (nunca se da por
 * buena una sesión sin pruebas), pero /debug/session-check lo responde como
 * no-200 para que la VM lo trate como ambiguo y reintente en vez de descartar
 * una sesión buena por un hipo de infraestructura.
 */
export type SessionCheck = { alive: boolean; note: string; error?: unknown; inconclusive?: boolean };

/**
 * ÚNICA regla para decidir si la sesión guardada sirve (/estado, keepAlive y
 * /debug/session-check, que es lo que consulta la VM antes de dar por buena
 * una publicación).
 *
 * Por qué existe: MEDIDO el 17-nov-2026, con la sesión VIVA del Dr. (/agenda
 * respondiendo), loadComponents devolvió [] (2 bytes) porque no había paciente
 * seleccionado, cosa normal tras un login fresco. La regla vieja "lista vacía
 * = sesión muerta" (7e74349, 20-oct) hacía que /estado dijera "caída", que el
 * keepAlive disparara recuperaciones innecesarias y que la VM rechazara su
 * propia publicación (log VM 16:36 UTC: 38 cookies HTTP 200 y luego
 * "worker-verification-failed").
 *
 * Protección del 29-jul que NO se afloja: una sesión muerta da 302 (al login)
 * o HTML, nunca 200 + JSON. Por eso un [] no basta solo: se confirma con la
 * agenda del día, que no depende del paciente. 302/401/403/HTML/JSON no-array
 * y [] sin agenda que confirme => no viva.
 *
 * Las funciones de carga se inyectan para poder probarla sin Bukeala real.
 * Si una carga lanza, el error se devuelve en `error` para que el llamador
 * distinga "Bukeala rechazó la sesión" de un fallo de red.
 */
export async function checkSessionUsable(
  loadComponents: () => Promise<Response>,
  loadAgenda: () => Promise<Response>,
): Promise<SessionCheck> {
  try {
    const response = await loadComponents();
    // clone(): ambas pruebas leen el cuerpo y un Response solo se lee una vez.
    if (await validComponentsResponse(response.clone())) {
      return { alive: true, note: "acceso autenticado comprobado" };
    }
    if (!(await isEmptyComponentsList(response))) {
      // 5xx = Bukeala caído, no un rechazo de la sesión: sin veredicto.
      return {
        alive: false, note: `HTTP ${response.status}: acceso autenticado no confirmado`,
        ...(response.status >= 500 ? { inconclusive: true } : {}),
      };
    }
    const agenda = await loadAgenda();
    if (await agendaConfirmsSession(agenda)) {
      return { alive: true, note: "acceso autenticado comprobado (componentes vacíos, confirmado por la agenda del día)" };
    }
    return {
      alive: false, note: `componentes vacíos y agenda HTTP ${agenda.status} sin confirmar: acceso autenticado no confirmado`,
      ...(agenda.status >= 500 ? { inconclusive: true } : {}),
    };
  } catch (error) {
    // SessionExpiredError (302 al login, 401/403, sin cookies) es un rechazo
    // real; cualquier otra excepción es red/proxy y no decide nada.
    const expired = error instanceof SessionExpiredError;
    return {
      alive: false,
      note: expired ? "sesión rechazada por Bukeala" : "no se pudo comprobar el acceso",
      error,
      ...(expired ? {} : { inconclusive: true }),
    };
  }
}

/**
 * Qué hace el keepAlive con un veredicto: "alive" sigue normal, "expired"
 * dispara recuperación y "inconclusive" solo registra (sin recuperación).
 * Antes un 5xx de Bukeala (sin excepción) caía en "expired" y pedía una
 * renovación innecesaria por un hipo del portal.
 */
export function keepAliveAction(check: SessionCheck): "alive" | "expired" | "inconclusive" {
  if (check.alive) return "alive";
  return check.inconclusive ? "inconclusive" : "expired";
}

/**
 * Respuesta de GET /debug/session-check, separada de la ruta para poder
 * probarla: 401 sin token válido, 503 sin veredicto (la VM reintenta), 200 con
 * {alive, note} cuando Bukeala decidió. Nunca se consulta Bukeala sin token.
 */
export async function sessionCheckResponse(
  token: string | undefined,
  expectedToken: string | undefined,
  loadComponents: () => Promise<Response>,
  loadAgenda: () => Promise<Response>,
): Promise<{ status: 200 | 401 | 503; body: Record<string, unknown> }> {
  if (!expectedToken || token !== expectedToken) return { status: 401, body: { error: "unauthorized" } };
  const { alive, note, inconclusive } = await checkSessionUsable(loadComponents, loadAgenda);
  if (inconclusive) return { status: 503, body: { alive: false, inconclusive: true, note } };
  return { status: 200, body: { alive, note } };
}

/** HTML/login pages and arbitrary JSON are not evidence that the API is usable. */
export async function probeSessionStatus(
  loadComponents: () => Promise<Response>,
  loadAgenda: () => Promise<Response>,
) {
  // Se descarta `error`: /estado solo muestra alive + nota.
  const { alive, note } = await checkSessionUsable(loadComponents, loadAgenda);
  return { alive, note };
}

export async function readRenewalCounts(env: Env, now = Date.now()) {
  // Existing counters are keyed by UTC, not Bogotá. Label this explicitly;
  // at 20:00 in Bogotá a UTC day already refers to the following date.
  const utcDay = new Date(now).toISOString().slice(0, 10);
  const buckets = [...REUSED_SESSION.map((via) => `ok:${via}`), "ok:persistent-login", "ok:captcha", "ok:captcha-fallback", "error"];
  const values = await Promise.all(buckets.map(async (bucket) => {
    const value = Number.parseInt(await env.STATE.get(`stats:renew:${utcDay}:${bucket}`) ?? "0", 10);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }));
  return {
    utcDay,
    reusedSession: values.slice(0, REUSED_SESSION.length).reduce((sum, value) => sum + value, 0),
    fullLogin: values[REUSED_SESSION.length],
    legacyCaptcha: values[REUSED_SESSION.length + 1] + values[REUSED_SESSION.length + 2],
    errors: values.at(-1) ?? 0,
  };
}

function elapsed(at: string, now: number): string {
  const timestamp = Date.parse(at);
  return Number.isFinite(timestamp) ? `hace ${Math.max(0, Math.round((now - timestamp) / 60000))} min` : "con fecha desconocida";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function recoveryLines(recovery: RecoveryStatus, now: number): string[] {
  if (!recovery) return ["No pude comprobar el estado de la recuperación. Puedes consultar /estado de nuevo."];
  if (!recovery.pending) return ["No hay una solicitud de recuperación confirmada. Puedes consultar /estado de nuevo."];
  const lines = recovery.needsHumanAttention
    ? ["⚠️ La recuperación requiere atención en el navegador de la VM. El proveedor puede estar pidiendo una verificación humana o revisar el acceso."]
    : [recovery.pickedUp ? "La VM recogió la solicitud; el resultado sigue pendiente." : "La recuperación está solicitada y pendiente de la VM."];
  if (recovery.nextAttemptAt && recovery.nextAttemptAt > now) {
    const time = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(recovery.nextAttemptAt);
    const minutes = Math.ceil((recovery.nextAttemptAt - now) / 60000);
    lines.push(`Próximo intento automático: ${time} (Bogotá), dentro de ${minutes} min.`);
  } else if (!recovery.pickedUp) {
    lines.push("La solicitud espera al siguiente ciclo de la VM; aún no hay un nuevo intento confirmado.");
  }
  lines.push(recovery.needsHumanAttention
    ? "Repetir el comando no elimina la verificación del proveedor ni adelanta el reintento."
    : "No necesitas repetir el comando. Te avisaré cuando se confirme la recuperación.");
  return lines;
}

export function formatSessionStatus(input: {
  alive: boolean;
  pingNote: string;
  capturedAt?: string;
  cookieCount: number;
  events: ServiceEvent[];
  recovery: RecoveryStatus;
  isDoctor: boolean;
  counts: Awaited<ReturnType<typeof readRenewalCounts>>;
  pendingWhatsApp: number;
  pendingTelegram: number;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const events = input.events.filter((event) => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = events.at(-1);
  const lastSuccess = events.filter((event) => event.type === "ok").at(-1);
  const lines = [
    input.alive ? "Bukeala: en línea ✅" : "Bukeala: sin acceso confirmado 🔴",
    lastSuccess ? `Último éxito de la VM: ${elapsed(lastSuccess.at, now)}` : "Último éxito de la VM: no consta en el registro disponible",
  ];
  if (!input.alive) lines.push("", ...recoveryLines(input.recovery, now));
  else if (input.recovery?.pending && input.recovery.needsHumanAttention) {
    // A valid session uploaded by another browser does not unblock the VM's
    // persistent login. Show both facts so a healthy API cannot hide this risk.
    lines.push("", "Renovación automática de la VM: requiere atención.", ...recoveryLines(input.recovery, now));
  }
  if (input.isDoctor) {
    lines.push("", "<i>Detalle técnico</i>", `Comprobación: ${escapeHtml(input.pingNote)}`,
      input.capturedAt
        ? `Última captura recibida: ${elapsed(input.capturedAt, now)} · ${input.cookieCount} cookies (no confirma acceso)`
        : "Sin captura de sesión guardada",
      last ? `Último intento VM: ${last.type === "ok" ? "✅ correcto" : "❌ falló"} ${elapsed(last.at, now)}${last.via ? ` vía ${escapeHtml(last.via)}` : ""}` : "VM: sin eventos reportados",
      `Contadores del ${input.counts.utcDay} (UTC): ${input.counts.reusedSession} éxitos reutilizando sesión · ${input.counts.fullLogin} con inicio de sesión completo · ${input.counts.legacyCaptcha} por el flujo anterior de captcha · ${input.counts.errors} errores`,
      input.pendingWhatsApp > 0 ? `Cola WhatsApp: ${input.pendingWhatsApp} paciente(s) esperando` : "Cola WhatsApp: vacía",
      input.pendingTelegram > 0 ? `Cola Telegram: ${input.pendingTelegram} comando(s) esperando (/pendientes_tg)` : "Cola Telegram: vacía",
    );
  }
  return lines.join("\n");
}
