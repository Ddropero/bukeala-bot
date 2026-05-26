/**
 * WhatsApp Business Profile management.
 *
 * Endpoints:
 *   GET  /wa/profile?token=<CAPTURE_TOKEN>
 *        → returns current profile (about, address, picture URL, etc.)
 *
 *   POST /wa/profile-picture?token=<CAPTURE_TOKEN>&url=<IMAGE_URL>
 *        → downloads the image, runs Meta's 3-step resumable upload, sets it
 *          as the WA Business profile picture. Optional JSON body to update
 *          other profile fields in the same call:
 *          {
 *            "url": "https://...jpg",         (or use ?url= query param)
 *            "about": "Cirujano plástico...",
 *            "address": "Calle 80 #...",
 *            "description": "...",
 *            "email": "info@davidduque.com",
 *            "vertical": "MEDICAL",            (HEALTH | MEDICAL | etc.)
 *            "websites": ["https://..."]
 *          }
 *
 * Image requirements (Meta):
 *   - Square (round-cropped in chats)
 *   - Min 192x192, max 640x640 px (recomendado)
 *   - JPG or PNG, max 5 MB
 *   - URL must be publicly accessible (HTTPS recomendado)
 */
import type { Context } from "hono";
import type { Env } from "../env";

const API_VERSION = "v21.0";

export async function handleGetProfile(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const fields = "about,address,description,email,messaging_product,profile_picture_url,vertical,websites";
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${c.env.WA_PHONE_ID}/whatsapp_business_profile?fields=${fields}`,
    { headers: { Authorization: `Bearer ${c.env.WA_TOKEN}` } },
  );
  const data = await res.json();
  return c.json(data, res.ok ? 200 : 500);
}

/**
 * Devuelve el display name (nombre comercial que ven los pacientes al guardar
 * el número), estado de aprobación, calidad de la línea, tier de mensajes, etc.
 */
export async function handlePhoneInfo(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const fields = [
    "verified_name",
    "display_phone_number",
    "code_verification_status",
    "quality_rating",
    "name_status",
    "messaging_limit_tier",
    "platform_type",
    "status",
    "throughput",
  ].join(",");
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${c.env.WA_PHONE_ID}?fields=${fields}`,
    { headers: { Authorization: `Bearer ${c.env.WA_TOKEN}` } },
  );
  return c.json(await res.json(), res.ok ? 200 : 500);
}

export async function handleUpdateProfilePicture(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // url puede venir por query string o por body JSON
  let imageUrl = c.req.query("url");
  let body: Record<string, any> = {};
  if (c.req.header("content-type")?.includes("application/json")) {
    try {
      body = await c.req.json();
      imageUrl = imageUrl ?? body.url;
    } catch {
      // ignore
    }
  }
  if (!imageUrl) {
    return c.json({
      error: "image url required",
      hint: "POST /wa/profile-picture?token=...&url=https://...jpg",
    }, 400);
  }

  try {
    // ── 1) Bajar la imagen de la URL ────────────────────────────────────
    console.log(`[wa-profile] GET ${imageUrl}`);
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      return c.json({ error: `failed to fetch image (${imgRes.status})` }, 400);
    }
    let contentType = imgRes.headers.get("content-type") || "image/jpeg";
    // Si el servidor no manda un content-type aceptable, asumir jpeg
    if (!/image\/(jpeg|jpg|png)/i.test(contentType)) {
      contentType = "image/jpeg";
    }
    const imgBuffer = await imgRes.arrayBuffer();
    const fileLength = imgBuffer.byteLength;
    console.log(`[wa-profile] downloaded ${fileLength}B as ${contentType}`);

    if (fileLength === 0) {
      return c.json({ error: "downloaded image is empty" }, 400);
    }
    if (fileLength > 5 * 1024 * 1024) {
      return c.json({ error: `image too large: ${fileLength}B (max 5MB)` }, 400);
    }

    // ── 2) Obtener el APP_ID via debug_token ────────────────────────────
    const debugRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${encodeURIComponent(c.env.WA_TOKEN)}&access_token=${encodeURIComponent(c.env.WA_TOKEN)}`,
    );
    const debugData = await debugRes.json<any>().catch(() => ({}));
    const appId = debugData?.data?.app_id;
    if (!appId) {
      return c.json({
        error: "could not derive app_id from WA_TOKEN",
        debug: debugData,
      }, 500);
    }
    console.log(`[wa-profile] app_id=${appId}`);

    // ── 3) Iniciar sesión de upload resumable ──────────────────────────
    const fileName = `profile.${contentType.includes("png") ? "png" : "jpg"}`;
    const startUrl =
      `https://graph.facebook.com/${API_VERSION}/${appId}/uploads` +
      `?file_name=${encodeURIComponent(fileName)}` +
      `&file_length=${fileLength}` +
      `&file_type=${encodeURIComponent(contentType)}`;
    const startRes = await fetch(startUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.env.WA_TOKEN}` },
    });
    const startData = await startRes.json<any>().catch(() => ({}));
    if (!startData?.id) {
      return c.json({
        error: "upload session start failed",
        status: startRes.status,
        details: startData,
      }, 500);
    }
    const sessionId = startData.id; // "upload:..."
    console.log(`[wa-profile] session=${sessionId}`);

    // ── 4) Subir bytes ─────────────────────────────────────────────────
    const uploadRes = await fetch(`https://graph.facebook.com/${sessionId}`, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${c.env.WA_TOKEN}`,
        file_offset: "0",
      },
      body: imgBuffer,
    });
    const uploadData = await uploadRes.json<any>().catch(() => ({}));
    if (!uploadData?.h) {
      return c.json({
        error: "byte upload failed",
        status: uploadRes.status,
        details: uploadData,
      }, 500);
    }
    const handle = uploadData.h;
    console.log(`[wa-profile] handle=${String(handle).slice(0, 30)}...`);

    // ── 5) Actualizar el WA Business Profile ───────────────────────────
    const profilePayload: Record<string, any> = {
      messaging_product: "whatsapp",
      profile_picture_handle: handle,
    };
    // Campos opcionales del body se incluyen si vienen
    for (const k of ["about", "address", "description", "email", "vertical"]) {
      if (typeof body[k] === "string" && body[k].length > 0) profilePayload[k] = body[k];
    }
    if (body.websites) {
      profilePayload.websites = Array.isArray(body.websites) ? body.websites : [body.websites];
    }

    const profRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${c.env.WA_PHONE_ID}/whatsapp_business_profile`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(profilePayload),
      },
    );
    const profData = await profRes.json<any>().catch(() => ({}));

    return c.json({
      ok: profRes.ok && profData?.success === true,
      bytes_uploaded: fileLength,
      content_type: contentType,
      handle_preview: String(handle).slice(0, 30) + "...",
      meta_response: profData,
      hint: profRes.ok
        ? "✅ Foto actualizada. La imagen tarda ~30 segundos en propagarse en Meta."
        : "❌ Error al actualizar perfil — revisa meta_response",
    }, profRes.ok ? 200 : 500);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
}
