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
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";
import { getDoctorRecipients } from "../users";
import { requestRefresh, getNativeHostEvents } from "../handlers/nativeHostEvent";

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
  // 1. Solo en horario laboral (de noche la expiración es esperada)
  const h = bogotaHour();
  if (h < 7 || h >= 19) {
    // Fuera de horario: limpiar cualquier estado de caída para empezar
    // fresco mañana.
    await env.STATE.delete("watchdog:downSince");
    await env.STATE.delete("watchdog:alerted");
    return;
  }

  // 2. Ping real a Bukeala
  let alive = false;
  try {
    const s = await loadSession(env);
    if (s) {
      const b = new Bukeala(env);
      const r = await b.findCustomerPage();
      await r.text();
      alive = r.status === 200;
    }
  } catch (e) {
    alive = !(e instanceof SessionExpiredError) ? false : false;
  }

  // 3a. Sesión viva → todo OK, limpiar estado de alarma
  if (alive) {
    const wasDown = await env.STATE.get("watchdog:downSince");
    const wasAlerted = await env.STATE.get("watchdog:alerted");
    await env.STATE.delete("watchdog:downSince");
    await env.STATE.delete("watchdog:alerted");
    // Si habíamos alertado una caída y ya se recuperó, avisar la recuperación.
    if (wasAlerted) {
      const doctors = await getDoctorRecipients(env);
      for (const chat of doctors) {
        await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text: "✅ <b>Sesión Bukeala recuperada</b>\n\nEl sistema volvió a la normalidad.",
            parse_mode: "HTML",
          }),
        }).catch(() => {});
      }
    }
    void wasDown;
    return;
  }

  // 3b. Sesión caída. ¿Desde cuándo?
  const downSinceRaw = await env.STATE.get("watchdog:downSince");
  const now = Date.now();
  if (!downSinceRaw) {
    // Primera detección de esta caída → marcar + intentar auto-recuperar
    await env.STATE.put("watchdog:downSince", new Date(now).toISOString(), {
      expirationTtl: 60 * 60 * 6,
    });
    try {
      await requestRefresh(env, "watchdog-autorecover");
      console.log("[watchdog] caída detectada — refresh on-demand disparado");
    } catch (e) {
      console.log("[watchdog] requestRefresh falló:", (e as Error).message);
    }
    return;
  }

  // Ya estaba caído antes. ¿Cuánto tiempo?
  const downMin = (now - new Date(downSinceRaw).getTime()) / 60000;
  if (downMin < GRACE_MIN) {
    // Aún en periodo de gracia: re-disparar refresh, no alertar todavía
    try { await requestRefresh(env, "watchdog-retry"); } catch { /* ignore */ }
    console.log(`[watchdog] caído hace ${downMin.toFixed(0)}min (gracia ${GRACE_MIN}min)`);
    return;
  }

  // Pasó el periodo de gracia → alertar UNA vez
  const alreadyAlerted = await env.STATE.get("watchdog:alerted");
  if (alreadyAlerted) {
    console.log("[watchdog] ya se alertó esta caída, skip");
    return;
  }

  const reason = await diagnose(env);
  const downMinRounded = Math.round(downMin);
  const doctors = await getDoctorRecipients(env);
  for (const chat of doctors) {
    await fetch(`${TG(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text:
          `🔴 <b>Alerta: Bukeala caído hace ${downMinRounded} min</b>\n\n` +
          `<b>Diagnóstico:</b> ${reason}\n\n` +
          `Ya intenté recuperarlo solo varias veces sin éxito.\n\n` +
          `<b>Qué hacer:</b>\n` +
          `• Revisa que la VM de Google esté prendida\n` +
          `• O prende el PC del consultorio (renueva de respaldo)\n` +
          `• O corre /sesion_renew\n\n` +
          `<i>Te aviso cuando se recupere.</i>`,
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }
  await env.STATE.put("watchdog:alerted", "1", { expirationTtl: 60 * 60 * 6 });
  console.log(`[watchdog] ALERTA enviada — caído ${downMinRounded}min: ${reason}`);
}
