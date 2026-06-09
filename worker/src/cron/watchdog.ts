/**
 * Watchdog — vigilante de salud del sistema de sesión Bukeala.
 *
 * Corre cada 5 min. Su trabajo: detectar cuando la sesión lleva DEMASIADO
 * tiempo caída en horario laboral (señal de que la VM/renovador no está
 * cumpliendo) y avisar UNA vez al doctor, sin spam.
 *
 * Lógica:
 *   1. Solo vigila en horario laboral Bogotá (7am-7pm). De noche la sesión
 *      expira a propósito (la VM duerme), así que no es una falla.
 *   2. Hace un ping real a Bukeala (findCustomer). Si responde 200 → todo OK,
 *      limpia cualquier estado de alarma previo.
 *   3. Si falla, mira hace cuánto está fallando (marca "downSince" en KV):
 *        - Primera detección → marca downSince + dispara un refresh on-demand
 *          (intento de auto-recuperación). NO avisa todavía.
 *        - Si sigue caído tras GRACE_MIN (20 min) → manda UN aviso al doctor
 *          con el diagnóstico probable, y no vuelve a avisar hasta que se
 *          recupere (evita spam).
 *
 * KV:
 *   watchdog:downSince   → ISO de cuándo empezó la caída actual
 *   watchdog:alerted     → "1" si ya avisamos por esta caída (TTL 6h)
 */
import type { Env } from "../env";
import { getDoctorRecipients } from "../users";
import { requestRefresh, getNativeHostEvents } from "../handlers/nativeHostEvent";
import { loadPendingRequests } from "../claudeBookingAgent";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;
const GRACE_MIN = 20; // minutos caído antes de alertar

function bogotaHour(): number {
  return (new Date().getUTCHours() - 5 + 24) % 24;
}

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

export async function watchdogCron(env: Env): Promise<void> {
  // Solo en horario laboral (de noche no se atienden pacientes).
  const h = bogotaHour();
  if (h < 7 || h >= 19) {
    await env.STATE.delete("watchdog:stuckSince");
    await env.STATE.delete("watchdog:alerted");
    return;
  }

  // MODO BAJO DEMANDA: la sesión está caída casi siempre A PROPÓSITO (solo se
  // renueva cuando llega un paciente). Por eso el watchdog YA NO vigila si la
  // sesión está viva — eso sería falsa alarma constante. En cambio vigila lo
  // que de verdad importa: ¿hay PACIENTES EN COLA que llevan rato sin ser
  // atendidos? Esa es la señal real de que el renovador no está funcionando.
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
