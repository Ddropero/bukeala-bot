/**
 * Cola de comandos de Telegram que fallaron porque Bukeala estaba caída.
 *
 * POR QUÉ: antes, cuando la sesión de Bukeala moría a mitad de un /hoy o un
 * /agenda, el bot contestaba "reintenta en ~1-2 min" y le devolvía el trabajo
 * al usuario. Ahora el comando se anota aquí y, apenas la sesión revive
 * (captura de cookies, evento `ok` del Native Host o ping bueno del keepAlive),
 * se re-ejecuta solo y el resultado llega al mismo chat. Es el mismo patrón que
 * ya usa la cola de WhatsApp (`processPendingRequests` en claudeBookingAgent.ts).
 *
 * Guardas contra los riesgos clásicos de una cola:
 *   - Duplicados: no se encola dos veces el mismo texto del mismo chat, y al
 *     procesar cada entrada se marca como "hecha" en KV (15 min) por si dos
 *     señales de "Bukeala volvió" llegan casi a la vez (captura + evento ok).
 *     Además hay un candado de 60 s para que dos corridas no se pisen.
 *   - Bucles: una entrada se reintenta como máximo UNA vez más (`intentos`);
 *     al segundo fallo se descarta y se avisa.
 *   - Antigüedad: lo de más de 45 min no se re-ejecuta (se avisa y se descarta);
 *     además la clave en KV vence sola a la hora.
 *   - Tamaño: máximo 20 entradas; se conservan las más recientes.
 */
import type { Env } from "./env";
import { SessionExpiredError } from "./bukeala";

const KV_KEY = "tg:pendingCommands";
const KV_LOCK = "tg:pendingCommands:lock";
const MAX_ENTRADAS = 20;
const TTL_COLA_SEG = 60 * 60; // 1 h: si en una hora no volvió, lo pedido ya no vale
const MAX_EDAD_MS = 45 * 60 * 1000; // 45 min: más viejo que esto no se re-ejecuta
const MAX_INTENTOS = 1; // reintentos adicionales permitidos tras el primero fallido

export type ComandoPendiente = {
  chatId: string;
  text: string;
  /** Epoch ms de cuando se encoló por primera vez (no se reinicia al reencolar). */
  at: number;
  /** Veces que ya se re-ejecutó y volvió a fallar por sesión. */
  intentos: number;
};

export async function cargarComandosPendientes(env: Env): Promise<ComandoPendiente[]> {
  const raw = await env.STATE.get(KV_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is ComandoPendiente =>
        !!e && typeof e.chatId === "string" && typeof e.text === "string" && typeof e.at === "number",
    );
  } catch {
    return [];
  }
}

async function guardar(env: Env, lista: ComandoPendiente[]): Promise<void> {
  if (lista.length === 0) {
    await env.STATE.delete(KV_KEY);
    return;
  }
  await env.STATE.put(KV_KEY, JSON.stringify(lista.slice(-MAX_ENTRADAS)), {
    expirationTtl: TTL_COLA_SEG,
  });
}

/**
 * Anota un comando para re-ejecutarlo cuando Bukeala vuelva.
 * Devuelve false si ya estaba anotado (mismo chat + mismo texto exacto).
 */
export async function encolarComando(env: Env, chatId: string, text: string): Promise<boolean> {
  const lista = await cargarComandosPendientes(env);
  if (lista.some((e) => e.chatId === chatId && e.text === text)) return false;
  lista.push({ chatId, text, at: Date.now(), intentos: 0 });
  await guardar(env, lista);
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Re-ejecuta lo que quedó pendiente. Llamar SOLO cuando hay señal de que la
 * sesión de Bukeala está viva (los mismos sitios donde se procesa la cola WA).
 */
export async function procesarComandosPendientes(
  env: Env,
): Promise<{ ejecutados: number; reencolados: number; descartados: number }> {
  const resumen = { ejecutados: 0, reencolados: 0, descartados: 0 };
  const lista = await cargarComandosPendientes(env);
  if (lista.length === 0) return resumen;

  // Candado corto: la captura de cookies y el evento `ok` del Native Host
  // llegan con segundos de diferencia; sin esto el usuario recibiría todo dos veces.
  if (await env.STATE.get(KV_LOCK)) {
    console.log("[tg-pending] otra corrida en curso, salto");
    return resumen;
  }
  await env.STATE.put(KV_LOCK, String(Date.now()), { expirationTtl: 60 });

  // Import dinámico: telegram.ts importa este módulo; así no hay ciclo al cargar.
  const { onText, sendMessage } = await import("./telegram");
  const reencolar: ComandoPendiente[] = [];

  try {
    // Tomamos la cola completa y la vaciamos; lo que vuelva a fallar se re-guarda al final.
    await env.STATE.delete(KV_KEY);

    for (const e of lista) {
      // Marca por entrada (incluye `intentos` para que un reintento sí corra).
      const marca = `tg:pendingCommands:done:${e.chatId}:${e.at}:${e.intentos}`;
      if (await env.STATE.get(marca)) continue; // ya lo hizo la otra corrida
      await env.STATE.put(marca, "1", { expirationTtl: 15 * 60 });

      const edadMin = Math.round((Date.now() - e.at) / 60000);
      const cmd = `<code>${escapeHtml(e.text)}</code>`;
      if (Date.now() - e.at > MAX_EDAD_MS) {
        resumen.descartados++;
        await sendMessage(
          env,
          e.chatId,
          `Bukeala volvió, pero lo que me pediste hace ${edadMin} min (${cmd}) ya está viejo y no lo repetí.\n<i>Si todavía lo necesitas, pídemelo otra vez.</i>`,
        ).catch(() => {});
        continue;
      }

      try {
        await sendMessage(env, e.chatId, `✅ Bukeala volvió. Aquí va lo que me pediste (${cmd}):`);
        await onText(env, e.chatId, e.text);
        resumen.ejecutados++;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          if (e.intentos < MAX_INTENTOS) {
            reencolar.push({ ...e, intentos: e.intentos + 1 });
            resumen.reencolados++;
            await sendMessage(
              env,
              e.chatId,
              "Se volvió a caer antes de responder 😕 Lo intento otra vez en la próxima renovación; no tienes que repetir nada.",
            ).catch(() => {});
          } else {
            resumen.descartados++;
            await sendMessage(
              env,
              e.chatId,
              `Sigue caída 😕 Te aviso cuando vuelva y ahí me pides ${cmd} otra vez.`,
            ).catch(() => {});
            // Para que el aviso de "✅ Sesión renovada" le llegue a ESTE chat.
            try {
              const { requestRefresh } = await import("./handlers/nativeHostEvent");
              await requestRefresh(env, e.chatId);
            } catch { /* best effort */ }
          }
        } else {
          resumen.descartados++;
          console.log(`[tg-pending] "${e.text}" falló al reintentar:`, (err as Error).message);
          await sendMessage(
            env,
            e.chatId,
            `❌ Al reintentar ${cmd} pasó esto: ${escapeHtml((err as Error).message).slice(0, 200)}\n<i>Pídemelo de nuevo cuando quieras.</i>`,
          ).catch(() => {});
        }
      }
    }

    if (reencolar.length > 0) {
      // Fusionar con lo que se haya encolado mientras procesábamos.
      const actual = await cargarComandosPendientes(env);
      for (const r of reencolar) {
        if (!actual.some((m) => m.chatId === r.chatId && m.text === r.text)) actual.push(r);
      }
      await guardar(env, actual);
    }
  } finally {
    await env.STATE.delete(KV_LOCK);
  }

  console.log(`[tg-pending] ${JSON.stringify(resumen)}`);
  return resumen;
}
