/**
 * Forum Topics — un hilo de Telegram por paciente.
 *
 * Cuando se configura un GRUPO de Telegram con "Temas" (forum) activados y se
 * pone su chat_id en TELEGRAM_HANDOFF_GROUP_ID, el handoff usa un hilo
 * dedicado por número de WhatsApp: cada paciente tiene su propia conversación
 * ordenada dentro del grupo, en lugar de mensajes sueltos en DMs.
 *
 * El bot debe ser ADMIN del grupo con permiso "Administrar temas"
 * (can_manage_topics).
 *
 * Mapeo persistente en KV:
 *   forum:topic:{phone}     → message_thread_id (number)  [el hilo del paciente]
 *   forum:phoneByTopic:{id} → phone                       [reverse, para responder]
 *
 * Si TELEGRAM_HANDOFF_GROUP_ID no está seteado, todo este módulo es inerte y
 * el handoff sigue con el comportamiento clásico (DMs a cada autorizado).
 */
import type { Env } from "./env";

const API = (token: string) => `https://api.telegram.org/bot${token}`;

/** ¿Está activado el modo Forum Topics? */
export function forumEnabled(env: Env): boolean {
  return !!(env.TELEGRAM_HANDOFF_BOT_TOKEN && (env as any).TELEGRAM_HANDOFF_GROUP_ID);
}

function groupId(env: Env): string {
  return String((env as any).TELEGRAM_HANDOFF_GROUP_ID || "");
}

/** Colores rotando para los iconos de tema (Telegram acepta una paleta fija). */
const TOPIC_COLORS = [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F];

function colorFor(phone: string): number {
  let h = 0;
  for (let i = 0; i < phone.length; i++) h = (h * 31 + phone.charCodeAt(i)) >>> 0;
  return TOPIC_COLORS[h % TOPIC_COLORS.length];
}

/**
 * Obtiene (o crea) el hilo del paciente. Devuelve el message_thread_id, o null
 * si no se pudo (grupo mal configurado, bot sin permisos, etc.).
 */
export async function getOrCreateTopic(
  env: Env,
  phone: string,
  patientName: string,
): Promise<number | null> {
  if (!forumEnabled(env)) return null;
  const token = env.TELEGRAM_HANDOFF_BOT_TOKEN!;
  const gid = groupId(env);

  // ¿Ya existe?
  const existing = await env.STATE.get(`forum:topic:${phone}`);
  if (existing) {
    const id = parseInt(existing, 10);
    if (Number.isFinite(id)) return id;
  }

  // Crear el hilo
  const title = `${patientName || "Paciente"} · ${phone.slice(-4)}`.slice(0, 128);
  try {
    const res = await fetch(`${API(token)}/createForumTopic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: gid,
        name: title,
        icon_color: colorFor(phone),
      }),
    });
    const data = await res.json<any>().catch(() => ({}));
    if (!res.ok || !data?.result?.message_thread_id) {
      console.log(`[forum] createForumTopic failed: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    const threadId = data.result.message_thread_id as number;
    // Persistir mapeo bidireccional (90 días)
    const ttl = 60 * 60 * 24 * 90;
    await env.STATE.put(`forum:topic:${phone}`, String(threadId), { expirationTtl: ttl });
    await env.STATE.put(`forum:phoneByTopic:${threadId}`, phone, { expirationTtl: ttl });
    console.log(`[forum] created topic ${threadId} for ${phone}`);
    return threadId;
  } catch (e) {
    console.log(`[forum] createForumTopic threw: ${(e as Error).message}`);
    return null;
  }
}

/** Devuelve el phone asociado a un message_thread_id (para responder). */
export async function phoneForTopic(env: Env, threadId: number): Promise<string | null> {
  return await env.STATE.get(`forum:phoneByTopic:${threadId}`);
}

/**
 * Envía un mensaje de texto dentro del hilo del paciente. Devuelve true si OK.
 */
export async function sendToTopic(
  env: Env,
  phone: string,
  patientName: string,
  text: string,
  replyMarkup?: object,
): Promise<boolean> {
  if (!forumEnabled(env)) return false;
  const token = env.TELEGRAM_HANDOFF_BOT_TOKEN!;
  const gid = groupId(env);
  const threadId = await getOrCreateTopic(env, phone, patientName);
  if (!threadId) return false;

  try {
    const res = await fetch(`${API(token)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: gid,
        message_thread_id: threadId,
        text,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`[forum] sendToTopic failed: ${res.status} ${body.slice(0, 200)}`);
      // Si el hilo fue borrado manualmente, limpiar el mapeo para recrearlo
      if (body.includes("thread not found") || body.includes("TOPIC_DELETED")) {
        await env.STATE.delete(`forum:topic:${phone}`);
        await env.STATE.delete(`forum:phoneByTopic:${threadId}`);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.log(`[forum] sendToTopic threw: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Cierra (archiva) el hilo de un paciente — útil cuando se devuelve a IA.
 * No borra el historial; Telegram lo deja colapsado. No es crítico si falla.
 */
export async function closeTopic(env: Env, phone: string): Promise<void> {
  if (!forumEnabled(env)) return;
  const token = env.TELEGRAM_HANDOFF_BOT_TOKEN!;
  const gid = groupId(env);
  const existing = await env.STATE.get(`forum:topic:${phone}`);
  if (!existing) return;
  const threadId = parseInt(existing, 10);
  if (!Number.isFinite(threadId)) return;
  try {
    await fetch(`${API(token)}/closeForumTopic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: gid, message_thread_id: threadId }),
    });
  } catch { /* no crítico */ }
}

/** Reabre el hilo (cuando vuelve a escalar tras haberse cerrado). */
export async function reopenTopic(env: Env, phone: string): Promise<void> {
  if (!forumEnabled(env)) return;
  const token = env.TELEGRAM_HANDOFF_BOT_TOKEN!;
  const gid = groupId(env);
  const existing = await env.STATE.get(`forum:topic:${phone}`);
  if (!existing) return;
  const threadId = parseInt(existing, 10);
  if (!Number.isFinite(threadId)) return;
  try {
    await fetch(`${API(token)}/reopenForumTopic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: gid, message_thread_id: threadId }),
    });
  } catch { /* no crítico */ }
}
