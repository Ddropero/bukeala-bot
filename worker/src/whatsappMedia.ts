/**
 * WhatsApp Cloud API — media (image/audio/document/video) helpers.
 *
 * Three operations:
 *   1. downloadWAMedia(env, mediaId)    — patient sent us media → bytes
 *   2. uploadWAMedia(env, buf, mime)    — we have bytes → upload → media_id
 *   3. sendWAMedia(env, to, type, ...)  — send media message to a contact
 *
 * Used by:
 *   - whatsappWebhook.ts (inbound) → patient sends image → bridge to Telegram
 *   - handoffBot.ts (outbound) → doctor sends photo in handoff bot → bridge to WhatsApp
 */
import type { Env } from "./env";

const API_VERSION = "v21.0";

/**
 * Download media from WhatsApp by media_id. The flow is two-step:
 *   1. GET /v21.0/{media_id}     → returns { url, mime_type, sha256, file_size, ... }
 *   2. GET <url> with Authorization → bytes
 *
 * Both calls require the WA_TOKEN.
 */
export async function downloadWAMedia(
  env: Env,
  mediaId: string,
): Promise<{ buffer: ArrayBuffer; mimeType: string } | null> {
  // Step 1: get media URL
  const metaRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WA_TOKEN}` },
  });
  if (!metaRes.ok) {
    console.log(`[wa-media] get URL failed for ${mediaId}: ${metaRes.status}`);
    return null;
  }
  const meta = await metaRes.json<any>();
  const url = meta?.url;
  const mimeType = meta?.mime_type ?? "application/octet-stream";
  if (!url) {
    console.log(`[wa-media] no URL in meta for ${mediaId}`);
    return null;
  }

  // Step 2: download bytes
  const bytesRes = await fetch(url, {
    headers: { Authorization: `Bearer ${env.WA_TOKEN}` },
  });
  if (!bytesRes.ok) {
    console.log(`[wa-media] download failed for ${mediaId}: ${bytesRes.status}`);
    return null;
  }
  const buffer = await bytesRes.arrayBuffer();
  return { buffer, mimeType };
}

/**
 * Upload media to WhatsApp servers via /v21.0/{phone-number-id}/media.
 * Returns the media_id used to send messages.
 *
 * Note: WA expects multipart/form-data with the file. We construct that
 * manually inside a Worker (no FormData polyfill needed — Workers support it).
 */
export async function uploadWAMedia(
  env: Env,
  buffer: ArrayBuffer,
  mimeType: string,
  filename = "file",
): Promise<string | null> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  // Blob with explicit type so Meta knows what it's getting
  const blob = new Blob([buffer], { type: mimeType });
  form.append("file", blob, filename);

  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${env.WA_PHONE_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}` },
    body: form,
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok || !data?.id) {
    console.log(`[wa-media] upload failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    return null;
  }
  return data.id;
}

/**
 * Send a media message to a WhatsApp contact, by media_id.
 *
 * @param type one of: image | audio | document | video | sticker
 * @param caption optional (only for image/document/video)
 * @param filename optional (only for document)
 */
export async function sendWAMedia(
  env: Env,
  to: string,
  type: "image" | "audio" | "document" | "video" | "sticker",
  mediaId: string,
  caption?: string,
  filename?: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const mediaObj: Record<string, any> = { id: mediaId };
  if (caption && (type === "image" || type === "document" || type === "video")) {
    mediaObj.caption = caption;
  }
  if (filename && type === "document") {
    mediaObj.filename = filename;
  }
  const body = {
    messaging_product: "whatsapp",
    to,
    type,
    [type]: mediaObj,
  };
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${env.WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.WA_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json<any>().catch(() => ({}));
  console.log(`[wa-media] send ${type} → ${res.status}`, JSON.stringify(data).slice(0, 300));
  return { ok: res.ok, status: res.status, data };
}

// ====================================================================
// Telegram media helpers (used by the handoff bot to relay)
// ====================================================================

/**
 * Resolve a Telegram file_id to a downloadable URL.
 * Telegram bot files only live for ~1 hour after getFile is called.
 */
export async function getTelegramFileUrl(
  botToken: string,
  fileId: string,
): Promise<{ url: string; size: number; path: string } | null> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    console.log(`[tg-media] getFile failed: ${res.status}`);
    return null;
  }
  const data = await res.json<any>();
  const file = data?.result;
  if (!file?.file_path) return null;
  return {
    url: `https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
    size: file.file_size ?? 0,
    path: file.file_path,
  };
}

/** Download a Telegram file by file_id and return the bytes + inferred mime. */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<{ buffer: ArrayBuffer; mimeType: string; filename: string } | null> {
  const f = await getTelegramFileUrl(botToken, fileId);
  if (!f) return null;
  const res = await fetch(f.url);
  if (!res.ok) {
    console.log(`[tg-media] download failed: ${res.status}`);
    return null;
  }
  const buffer = await res.arrayBuffer();
  // Inferir MIME por extensión
  const ext = (f.path.split(".").pop() ?? "").toLowerCase();
  const filename = f.path.split("/").pop() ?? "file";
  let mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  // Telegram a veces devuelve octet-stream; mapear por extensión
  if (mimeType === "application/octet-stream" || mimeType.startsWith("text/")) {
    const map: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
      pdf: "application/pdf",
      mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4",
      mp4: "video/mp4", mov: "video/quicktime",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    if (map[ext]) mimeType = map[ext];
  }
  return { buffer, mimeType, filename };
}

/** Send a photo to a Telegram chat. The buffer must be < 10 MB for sendPhoto. */
export async function sendTelegramPhoto(
  botToken: string,
  chatId: string,
  buffer: ArrayBuffer,
  caption?: string,
  filename = "photo.jpg",
  parseMode: "HTML" | "MarkdownV2" = "HTML",
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", parseMode);
  }
  form.append("photo", new Blob([buffer], { type: "image/jpeg" }), filename);
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok) {
    console.log(`[tg-media] sendPhoto failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return res.ok;
}

/** Send a document (PDF, etc.) to a Telegram chat. */
export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string,
  caption?: string,
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  form.append("document", new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    console.log(`[tg-media] sendDocument failed: ${res.status}`);
  }
  return res.ok;
}

/** Send a video to a Telegram chat (reproducible inline, max 50MB). */
export async function sendTelegramVideo(
  botToken: string,
  chatId: string,
  buffer: ArrayBuffer,
  caption?: string,
  filename = "video.mp4",
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  form.append("supports_streaming", "true");
  form.append("video", new Blob([buffer], { type: "video/mp4" }), filename);
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.log(`[tg-media] sendVideo failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.ok;
}

/** Send a voice note (audio) to a Telegram chat. */
export async function sendTelegramVoice(
  botToken: string,
  chatId: string,
  buffer: ArrayBuffer,
  caption?: string,
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  form.append("voice", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    console.log(`[tg-media] sendVoice failed: ${res.status}`);
  }
  return res.ok;
}
