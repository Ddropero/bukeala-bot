/**
 * Watchdog — vigilante de salud del sistema de sesión Bukeala.
 *
 * Corre cada 15 min, las 24 horas. Vigila dos señales independientes:
 *   1. Reportes del renovador atrasados, respetando la espera registrada
 *      entre reintentos. La ausencia de eventos no prueba que la VM se apagó.
 *   2. Pacientes en cola durante GRACE_MIN (20 min) o más.
 * El acceso real a Bukeala se verifica en keepalive y /estado.
 *
 * Además (vigilancia 0) avisa al Dr. si la VM lleva 2 h+ sin NINGÚN evento.
 *
 * KV:
 *   watchdog:vmSilent            → VM muda: {alertedAt, lastEventAt} (TTL 30d)
 *   watchdog:renewerStaleAlerted → alerta por reportes atrasados (TTL 3h)
 *   watchdog:alerted             → alerta por pacientes en cola (TTL 6h)
 */
import type { Env } from "../env";
import { getDoctorRecipients } from "../users";
import { requestRefresh, getNativeHostEvents, isCycleTimeoutEvent } from "../handlers/nativeHostEvent";
import { loadPendingRequests } from "../claudeBookingAgent";
import { getRecoveryStatus } from "../sessionRecovery";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;
const GRACE_MIN = 20; // minutos caído antes de alertar

/** Diagnóstico probable de por qué está caído, leyendo los últimos eventos. */
async function diagnose(env: Env): Promise<string> {
  try {
    const events = await getNativeHostEvents(env);
    const recent = events.slice(-8);
    if (recent.length === 0) {
      return "El renovador (VM) no ha reportado NINGÚN evento reciente. Probable: VM apagada o sin internet.";
    }
    const lastOk = [...recent].reverse().find((e) => e.type === "ok");
    const lastErr = [...recent].reverse().find((e) => e.type !== "ok");
    // ¿El último error menciona 2Captcha sin saldo?
    if (lastErr?.message && /ZERO_BALANCE|balance|saldo/i.test(lastErr.message)) {
      return "2Captcha sin saldo. Recarga en https://2captcha.com → Add funds.";
    }
    if (lastErr?.message && /captcha/i.test(lastErr.message)) {
      return `Falla resolviendo el captcha: ${lastErr.message.slice(0, 100)}`;
    }
    if (!lastOk) {
      return "Los últimos intentos de login fallaron. Revisa la VM (logs) o credenciales CAS.";
    }
    const mins = Math.round((Date.now() - new Date(lastOk.at).getTime()) / 60000);
    return `Último login OK hace ${mins} min, pero la sesión no aguanta. Posible problema de cookies o la VM dejó de renovar.`;
  } catch {
    return "No se pudo diagnosticar (sin datos de eventos).";
  }
}

/**
 * Detecta reportes atrasados sin confundir el backoff de 30/60 min con una
 * caída de la VM. Tras el plazo registrado damos 5 min para completar el
 * intento y publicar su resultado; el cron siguiente puede alertar.
 */
const STALE_MIN = 25; // la VM renueva cada ~10 min → 25 min = 2 ciclos perdidos
const RETRY_REPORT_GRACE_MS = 5 * 60 * 1000;
const MAX_RETRY_WAIT_MS = 60 * 60 * 1000; // límite del coordinador de recuperación

async function checkRenewerAlive(env: Env): Promise<void> {
  let lastAt = 0;
  try {
    const events = await getNativeHostEvents(env);
    for (const e of events) {
      const t = new Date(e.at).getTime();
      if (Number.isFinite(t) && t > lastAt) lastAt = t;
    }
  } catch { return; /* sin datos: no inventamos alarma */ }
  if (!lastAt) return;

  const now = Date.now();
  const ageMin = (now - lastAt) / 60000;
  if (ageMin < STALE_MIN) {
    await env.STATE.delete("watchdog:renewerStaleAlerted");
    return;
  }

  let recovery;
  try { recovery = await getRecoveryStatus(env, now); }
  catch {
    // Sin el plazo no podemos distinguir una espera prevista de un reporte
    // perdido. No confirmamos salud ni borramos una alerta previa.
    console.log("[watchdog] estado de recuperación no disponible; diagnóstico inconcluso");
    return;
  }
  if (recovery.pending && recovery.nextAttemptAt &&
      recovery.nextAttemptAt <= now + MAX_RETRY_WAIT_MS &&
      now < recovery.nextAttemptAt + RETRY_REPORT_GRACE_MS) {
    return;
  }

  let refreshRequested = false;
  try {
    await requestRefresh(env, "watchdog-renovador-mudo");
    refreshRequested = true;
  } catch { /* el aviso debe distinguir un intento de una solicitud guardada */ }

  if (await env.STATE.get("watchdog:renewerStaleAlerted")) return;
  await env.STATE.put("watchdog:renewerStaleAlerted", "1", { expirationTtl: 60 * 60 * 3 });

  const doctors = await getDoctorRecipients(env);
  for (const chat of doctors) {
    await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text:
          `⚠️ <b>El renovador no tiene un nuevo reporte hace ${Math.round(ageMin)} min</b>\n\n` +
          "No llegó otro reporte dentro del plazo esperado. Esto no confirma que la VM esté apagada: " +
          "puede haber un problema de ejecución o comunicación.\n\n" +
          (refreshRequested
            ? "La recuperación quedó solicitada y respetará la espera entre reintentos.\n\n"
            : "No pude confirmar que se guardara la solicitud de recuperación.\n\n") +
          "Comprueba el acceso y el estado de recuperación con /estado. " +
          "Si siguen faltando reportes, revisa el servicio en la VM <code>bukeala-session-keeper</code>.",
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }
  console.log(`[watchdog] ALERTA reporte del renovador atrasado hace ${Math.round(ageMin)} min`);
}

/**
 * VM MUDA — aviso directo al Dr.
 *
 * POR QUÉ EXISTE: del 10 al 17/nov/2026 la VM quedó con el proceso vivo pero
 * colgado y no mandó un solo evento en 7 días. checkRenewerAlive solo pedía
 * requestRefresh (que un proceso colgado no puede atender) y su aviso quedaba
 * tapado por la espera de recuperación, así que nadie se enteró.
 *
 * Este chequeo es INDEPENDIENTE de requestRecovery/pollRecovery: no pide nada,
 * no lee su estado y no lo modifica; solo mira la hora del último evento.
 *
 * UMBRAL de 2 h: en un backoff legítimo la VM puede pasar hasta 60 min sin
 * hablar con el Worker (no consulta órdenes durante la espera, por diseño).
 * El doble de ese máximo evita falsas alarmas y aun así avisa el mismo día,
 * no una semana después.
 */
const VM_SILENT_MS = 2 * 60 * 60 * 1000;
const VM_SILENT_REPEAT_MS = 6 * 60 * 60 * 1000; // máximo una alerta cada 6 h
const VM_SILENT_KEY = "watchdog:vmSilent";

interface VmSilentMarker { alertedAt: number; lastEventAt: number }

function describeAge(ms: number): string {
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} días`;
}

async function sendDoctors(env: Env, text: string): Promise<void> {
  const doctors = await getDoctorRecipients(env);
  for (const chat of doctors) {
    await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    }).catch(() => {});
  }
}

export async function checkVmSilent(env: Env, now = Date.now()): Promise<void> {
  // Se mide desde el último evento ÚTIL, no desde cualquiera. Un cycle-timeout
  // lo manda la VM justo antes de reiniciarse por un cuelgue: si se contara,
  // una VM colgándose en bucle (un evento cada ~18 min) nunca parecería muda y
  // el primer cuelgue tras un silencio daría un falso "volvió a reportar".
  let lastAt = 0;
  let oldestAt = 0;
  let timeoutsSince = 0;
  try {
    const events = await getNativeHostEvents(env);
    for (const e of events) {
      const t = new Date(e.at).getTime();
      if (!Number.isFinite(t)) continue;
      if (!oldestAt || t < oldestAt) oldestAt = t;
      if (!isCycleTimeoutEvent(e) && t > lastAt) lastAt = t;
    }
    for (const e of events) {
      const t = new Date(e.at).getTime();
      if (isCycleTimeoutEvent(e) && Number.isFinite(t) && t > lastAt) timeoutsSince++;
    }
  } catch { return; /* sin datos: no inventamos alarma */ }

  let marker: VmSilentMarker | null = null;
  try {
    const raw = await env.STATE.get(VM_SILENT_KEY);
    if (raw) marker = JSON.parse(raw);
  } catch { return; /* sin el throttle podríamos repetir el aviso cada 15 min */ }

  // Anillo vacío pero ya sabíamos de un silencio: sigue mudo desde entonces.
  if (!lastAt && marker?.lastEventAt) lastAt = marker.lastEventAt;
  // Anillo hecho SOLO de cycle-timeouts: no hay evento útil que fechar, pero
  // el más viejo es una cota segura de cuándo empezó el bucle.
  if (!lastAt && timeoutsSince) lastAt = oldestAt;
  if (!lastAt) return;
  const silentMs = now - lastAt;

  if (silentMs < VM_SILENT_MS) {
    // Volvió a reportar: avisarlo UNA sola vez y soltar el marcador.
    if (marker) {
      await env.STATE.delete(VM_SILENT_KEY);
      await sendDoctors(env,
        "✅ <b>La VM volvió a reportar</b>\n\n" +
        `El renovador de sesión de Bukeala mandó un evento de nuevo tras ${describeAge(Math.max(0, lastAt - marker.lastEventAt))} en silencio.`);
      console.log("[watchdog] VM volvió a reportar");
    }
    return;
  }

  if (marker && now - marker.alertedAt < VM_SILENT_REPEAT_MS) return;
  // Primero el marcador: si Telegram falla, no reintentamos en 15 min.
  const next: VmSilentMarker = { alertedAt: now, lastEventAt: lastAt };
  await env.STATE.put(VM_SILENT_KEY, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 30 });
  await sendDoctors(env,
    `🔴 <b>La VM no reporta hace ${describeAge(silentMs)}</b>\n\n` +
    (timeoutsSince
      ? `El renovador de sesión de Bukeala (VM de Google) solo ha mandado avisos de cuelgue (${timeoutsSince} reinicios) y ningún resultado útil. `
      : "El renovador de sesión de Bukeala (VM de Google) no ha mandado ningún evento. ") +
    "Mientras siga así, la sesión no se renueva y el bot puede dejar de ver la agenda.\n\n" +
    "<b>Qué hacer:</b>\n" +
    "1. Entra a Bukeala en Brave en tu PC (con la extensión) para dejar una sesión fresca.\n" +
    "2. Si sigue igual, reinicia la máquina desde el celular: en el navegador abre " +
    "console.cloud.google.com → Compute Engine → Instancias de VM → <code>bukeala-session-keeper</code> → " +
    "<b>Restablecer</b>. La VM ya reinicia sola un proceso colgado; si aun así no reporta, " +
    "la máquina entera está trabada.\n\n" +
    "<i>Repito este aviso cada 6 h mientras siga muda y te escribo cuando vuelva.</i>");
  console.log(`[watchdog] ALERTA VM muda hace ${Math.round(silentMs / 60000)} min`);
}

export async function watchdogCron(env: Env): Promise<void> {
  // 24/7: ya no hay gate de horario laboral. La VM renueva a toda hora, así
  // que una sesión caída de madrugada es una falla real (y los pacientes
  // escriben por WhatsApp a cualquier hora).

  // VIGILANCIA 0 — ¿la VM lleva 2 h+ sin mandar NINGÚN evento? Va antes y
  // aparte de la 1, cuyas salidas tempranas (espera de recuperación) no deben
  // poder silenciar este aviso. Un fallo aquí no frena las demás vigilancias.
  try { await checkVmSilent(env); }
  catch (e) { console.log("[watchdog] chequeo de VM muda falló:", (e as Error).message); }

  // VIGILANCIA 1 — ¿faltan reportes fuera de la espera entre reintentos?
  // Esto NO depende de que haya pacientes en cola ni confirma acceso a Bukeala.
  await checkRenewerAlive(env);

  // VIGILANCIA 2 — ¿hay PACIENTES EN COLA sin atender? Señal de que el
  // renovador no está cumpliendo aunque reporte eventos.
  let pending: Array<{ queuedAt?: number }> = [];
  try { pending = (await loadPendingRequests(env)) as any[]; } catch { /* ignore */ }

  const now = Date.now();
  // Pacientes en cola que llevan más de GRACE_MIN esperando.
  const stuck = pending.filter((p) => p.queuedAt && (now - p.queuedAt) / 60000 >= GRACE_MIN);

  // Sin pacientes atascados → todo bien. Si veníamos de una alerta, avisar OK.
  if (stuck.length === 0) {
    const wasAlerted = await env.STATE.get("watchdog:alerted");
    await env.STATE.delete("watchdog:stuckSince");
    await env.STATE.delete("watchdog:alerted");
    if (wasAlerted) {
      const doctors = await getDoctorRecipients(env);
      for (const chat of doctors) {
        await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text: "✅ <b>Cola de pacientes procesada</b>\n\nEl sistema volvió a la normalidad.",
            parse_mode: "HTML",
          }),
        }).catch(() => {});
      }
    }
    return;
  }

  // Hay pacientes atascados. Intentar recuperar (forzar refresh) e informar
  // una sola vez.
  try { await requestRefresh(env, "watchdog-pending-stuck"); } catch { /* ignore */ }

  const alreadyAlerted = await env.STATE.get("watchdog:alerted");
  if (alreadyAlerted) {
    console.log(`[watchdog] ${stuck.length} pacientes en cola, ya alertado`);
    return;
  }

  const reason = await diagnose(env);
  const doctors = await getDoctorRecipients(env);
  for (const chat of doctors) {
    await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text:
          `🔴 <b>Alerta: ${stuck.length} paciente(s) sin atender hace ${GRACE_MIN}+ min</b>\n\n` +
          `Hay solicitudes en cola que el sistema no logró procesar.\n\n` +
          `<b>Diagnóstico:</b> ${reason}\n\n` +
          `Ya intenté recuperarlo solo. Si sigue:\n` +
          `• Revisa que la VM de Google esté prendida\n` +
          `• O corre /sesion_renew\n` +
          `• Revisa /wa_pending para ver la cola\n\n` +
          `<i>Te aviso cuando se procese.</i>`,
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }
  await env.STATE.put("watchdog:alerted", "1", { expirationTtl: 60 * 60 * 6 });
  console.log(`[watchdog] ALERTA — ${stuck.length} pacientes atascados: ${reason}`);
}
