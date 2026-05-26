/**
 * Instagram Messaging API client (vía Meta Graph API).
 *
 * Permite que el mismo bot que atiende WhatsApp responda DMs de Instagram.
 * Endpoint usado: /{IG_BUSINESS_ACCOUNT_ID}/messages
 *
 * Requisitos:
 *   - Cuenta Instagram convertida a Business/Profesional
 *   - Conectada a una Página de Facebook
 *   - Meta App con permisos instagram_basic + instagram_manage_messages
 *   - System User token con scope a esa página
 *   - Webhook suscrito al evento "messages"
 *
 * Ventana de respuesta: 7 días desde el último mensaje del usuario
 * (Instagram permite más holgura que WhatsApp pero NO templates pre-aprobados).
 */
import type { Env } from "./env";

const API_VERSION = "v21.0";

function apiUrl(env: Env): string {
  return `https://graph.facebook.com/${API_VERSION}/${env.IG_BUSINESS_ACCOUNT_ID}/messages`;
}

async function postIg(env: Env, body: object): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(apiUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[instagram] POST → ${res.status}`, JSON.stringify(data).slice(0, 400));
  return { ok: res.ok, status: res.status, data };
}

/** Texto libre. Solo funciona dentro de ventana de 7 días desde el último mensaje del usuario. */
export async function sendIgText(env: Env, recipientId: string, text: string) {
  return postIg(env, {
    recipient: { id: recipientId },
    message: { text },
  });
}

/** Imagen por URL pública. */
export async function sendIgImage(env: Env, recipientId: string, imageUrl: string) {
  return postIg(env, {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: "image",
        payload: { url: imageUrl, is_reusable: true },
      },
    },
  });
}

/** Mensaje con botones quick-reply (máx 13 botones, 20 chars cada uno). */
export async function sendIgQuickReplies(
  env: Env,
  recipientId: string,
  text: string,
  options: Array<{ title: string; payload: string }>,
) {
  return postIg(env, {
    recipient: { id: recipientId },
    message: {
      text,
      quick_replies: options.slice(0, 13).map((o) => ({
        content_type: "text",
        title: o.title.slice(0, 20),
        payload: o.payload,
      })),
    },
  });
}

/** Marcar como visto + activar "typing..." (mejora UX). */
export async function sendIgSenderAction(
  env: Env,
  recipientId: string,
  action: "mark_seen" | "typing_on" | "typing_off",
) {
  return postIg(env, {
    recipient: { id: recipientId },
    sender_action: action,
  });
}

/**
 * Obtiene metadata del usuario (nombre, foto). Útil para enriquecer las
 * notificaciones al handoff bot.
 *
 * Requiere campo `name` habilitado en permisos.
 */
export async function getIgUserProfile(env: Env, userId: string): Promise<{
  name?: string;
  username?: string;
  profile_pic?: string;
} | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${userId}?fields=name,username,profile_pic&access_token=${env.IG_ACCESS_TOKEN}`,
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("[instagram] getIgUserProfile failed:", (e as Error).message);
    return null;
  }
}
