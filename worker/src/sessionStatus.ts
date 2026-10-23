import type { Env } from "./env";
import { SessionExpiredError } from "./bukeala";
import { validComponentsResponse, type getRecoveryStatus } from "./sessionRecovery";

type RecoveryStatus = Awaited<ReturnType<typeof getRecoveryStatus>> | null;
type ServiceEvent = { type: string; at: string; via?: string };
const REUSED_SESSION = ["alive", "tgc", "persistent", "persistent-adopted"];

/** HTML/login pages and arbitrary JSON are not evidence that the API is usable. */
export async function probeSessionStatus(loadComponents: () => Promise<Response>) {
  try {
    const response = await loadComponents();
    const alive = await validComponentsResponse(response);
    return {
      alive,
      note: alive ? "acceso autenticado comprobado" : `HTTP ${response.status}: acceso autenticado no confirmado`,
    };
  } catch (error) {
    return {
      alive: false,
      note: error instanceof SessionExpiredError ? "sesión rechazada por Bukeala" : "no se pudo comprobar el acceso",
    };
  }
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
