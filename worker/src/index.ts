import { Hono } from "hono";
import type { Env } from "./env";
import { handleCapture } from "./handlers/capture";
import { handleTelegramWebhook, setupWebhook } from "./handlers/webhook";
import { handleDebug } from "./handlers/debug";
import { verifyWhatsAppWebhook, handleWhatsAppWebhook } from "./handlers/whatsappWebhook";
import { verifyInstagramWebhook, handleInstagramWebhook } from "./handlers/instagramWebhook";
import { handleIgDiscover } from "./handlers/instagramDiscover";
import { handleGetProfile, handleUpdateProfilePicture, handlePhoneInfo } from "./handlers/whatsappProfile";
import { handleListTemplates, handleCreateTemplates, handleCreateAgendaTemplate, handleCreateDocTemplate, handleCreateReminderTemplate } from "./handlers/waTemplates";
import { handleDashboard } from "./handlers/dashboard";
import { handlePanel } from "./handlers/panel";
import { handleApiAgenda } from "./handlers/apiAgenda";
import { handleNativeHostEvent, handleCheckRefresh, handleRefreshComplete, handleGetTgc } from "./handlers/nativeHostEvent";
import {
  handleExtensionRequestSend,
  handleExtensionCheckSend,
  handleExtensionSendComplete,
  handleExtensionStatus,
} from "./handlers/extensionCommand";
import { Bukeala, SessionExpiredError } from "./bukeala";
import { loadSession } from "./kv";
import { dailySummary } from "./cron/dailySummary";
import { newBookingsCheck } from "./cron/newBookingsWatch";
import { reminderCron } from "./cron/reminderCron";
import { autoReturnToAI } from "./cron/autoReturnToAI";
import { watchdogCron } from "./cron/watchdog";
import { weeklyReport } from "./cron/weeklyReport";
import { quoteFollowup } from "./cron/quoteFollowup";
import { secretaryAgendaCron } from "./cron/secretaryAgenda";
import { eveningReminderCron } from "./cron/eveningReminder";
import { espejoCalendarCron } from "./cron/espejoCalendar";
import { getDoctorRecipients } from "./users";
import { processPendingRequests, loadPendingRequests } from "./claudeBookingAgent";
import { requestRefresh } from "./handlers/nativeHostEvent";
import { handleHandoffWebhook, setupHandoffWebhook } from "./handoffBot";
import { handleQuotesWebhook, setupQuotesWebhook } from "./quotesBot";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { BukealaMcp } from "./mcp/server";
import { registerMcpAuthRoutes } from "./mcp/authorize";

// Re-export the Durable Object classes so wrangler can find them.
export { BukealaProxy } from "./proxy";
export { BukealaMcp } from "./mcp/server";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Bukeala bot worker — alive"));

// OAuth consent screen para el MCP (GET/POST /authorize). El resto de
// endpoints OAuth (/token, /register, discovery) los implementa OAuthProvider.
registerMcpAuthRoutes(app);

// Cookie capture from the browser extension
app.post("/capture", handleCapture);

// Native Host event reporter (success / TGC expired / errors)
app.post("/native-host/event", handleNativeHostEvent);

// Native Host watcher polling endpoint — checks if /sesion_renew was requested
app.get("/native-host/check-refresh", handleCheckRefresh);

// Native Host reports back when refresh completed (success/fail) → notifies requester
app.post("/native-host/refresh-complete", handleRefreshComplete);

// TGC rescue: la VM recupera el TGC de la última sesión en KV tras un reboot
// (evita gastar captcha para re-bootstrapear). Solo devuelve cookies TGC.
app.get("/native-host/tgc", handleGetTgc);

// Cola de órdenes para la EXTENSIÓN del navegador del Dr. — renovación remota
// SIN abrir el popup. Mismo patrón que /native-host/check-refresh pero con
// llaves KV propias (ext:*), porque la VM y la extensión son ejecutores
// distintos. Ver handlers/extensionCommand.ts para el porqué de cada pieza.
//   POST /extension/request-send  → encolar orden (Telegram /renovar_navegador o curl)
//   GET  /extension/check-send    → la extensión sondea cada ~1 min
//   POST /extension/send-complete → la extensión reporta el resultado
//   GET  /extension/status        → diagnóstico (último resultado + heartbeat)
app.post("/extension/request-send", handleExtensionRequestSend);
app.get("/extension/check-send", handleExtensionCheckSend);
app.post("/extension/send-complete", handleExtensionSendComplete);
app.get("/extension/status", handleExtensionStatus);

// Telegram webhook (Telegram → Worker)
app.post("/tg/webhook", handleTelegramWebhook);

// One-time setup (call manually once after deploy):
//   curl https://<worker>.workers.dev/tg/setup?token=<CAPTURE_TOKEN>
app.get("/tg/setup", setupWebhook);

// Handoff bot — bot DEDICADO al chat humano cuando AI escala.
// Setup:
//   1) crea bot en @BotFather (eg. @drduque_directo_bot)
//   2) wrangler secret put TELEGRAM_HANDOFF_BOT_TOKEN
//   3) curl https://<worker>/tg/handoff-setup?token=<CAPTURE_TOKEN>
app.post("/tg/handoff-webhook", handleHandoffWebhook);
app.get("/tg/handoff-setup", setupHandoffWebhook);
// Helper de setup Forum Topics: devuelve el último grupo donde el handoff bot
// vio un mensaje (para configurar TELEGRAM_HANDOFF_GROUP_ID).
app.get("/tg/last-group", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const raw = await c.env.STATE.get("forum:lastGroupSeen");
  return c.json(raw ? JSON.parse(raw) : { note: "Aún no he visto ningún grupo. Escribe algo en el grupo con el bot dentro." });
});

// Bot de COTIZACIONES — Andrea, encargada de ventas/cotizaciones.
// Setup:
//   1) crea bot en @BotFather (eg. @cotizadavid_bot)
//   2) wrangler secret put TELEGRAM_QUOTES_BOT_TOKEN
//   3) curl https://<worker>/tg/quotes-setup?token=<CAPTURE_TOKEN>
app.post("/tg/quotes-webhook", handleQuotesWebhook);
app.get("/tg/quotes-setup", setupQuotesWebhook);

// WhatsApp Cloud API webhook (Meta → Worker)
//   GET  → verification handshake (hub.verify_token must match WA_VERIFY_TOKEN)
//   POST → incoming messages + delivery statuses
app.get("/wa/webhook", verifyWhatsAppWebhook);
app.post("/wa/webhook", handleWhatsAppWebhook);

// WhatsApp Business Profile management
//   GET  /wa/profile?token=<CAPTURE_TOKEN>                   → current profile
//   POST /wa/profile-picture?token=<CAPTURE_TOKEN>&url=<...> → upload + set
//   GET  /wa/phone-info?token=<CAPTURE_TOKEN>                → display_name, quality, status
app.get("/wa/profile", handleGetProfile);
app.post("/wa/profile-picture", handleUpdateProfilePicture);
// Gestión de plantillas vía Graph API (sin navegador):
//   GET /wa/templates?token=..        → lista plantillas
//   GET /wa/templates/create?token=.. → crea confirmar_cita + appointment_reminder
app.get("/wa/templates", handleListTemplates);
app.get("/wa/templates/create", handleCreateTemplates);
// Plantilla con cabecera de DOCUMENTO para mandar la agenda fuera de 24h
app.get("/wa/templates/create-agenda", handleCreateAgendaTemplate);
// Plantilla genérica para enviarle un documento a un paciente fuera de 24h
app.get("/wa/templates/create-doc", handleCreateDocTemplate);
// API de lectura de la agenda para apps externas (Mayordomo).
//   GET /api/agenda?token=..&date=DD-MM-YYYY&days=N
app.get("/api/agenda", handleApiAgenda);

// Plantilla de recordatorios personales del doctor (Mayordomo)
app.get("/wa/templates/create-reminder", handleCreateReminderTemplate);

/**
 * Recordatorio personal al WhatsApp del doctor. Pensado para MAYORDOMO.
 *
 *   POST /wa/notify-me?token=<CAPTURE_TOKEN>
 *   Content-Type: application/json
 *   { "titulo": "Llamar al laboratorio", "detalle": "Resultados pendientes" }
 *
 * También acepta los datos por query (?titulo=..&detalle=..) y un ?to= para
 * mandarlo a otro número. Por defecto usa DOCTOR_WHATSAPP_NUMBER.
 *
 * Devuelve { ok, via: "texto" | "plantilla" }. "plantilla" significa que iba
 * fuera de la ventana de 24h y salió por `recordatorio_personal` — que es lo
 * que permite que un recordatorio llegue a cualquier hora.
 */
app.post("/wa/notify-me", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let titulo = c.req.query("titulo") ?? "";
  let detalle = c.req.query("detalle") ?? "";
  let to = c.req.query("to") ?? "";
  // Body JSON (lo normal desde Mayordomo); si no viene, se usan los query params.
  try {
    const body = (await c.req.json()) as any;
    if (body?.titulo) titulo = String(body.titulo);
    if (body?.detalle) detalle = String(body.detalle);
    if (body?.to) to = String(body.to);
  } catch { /* sin body: seguimos con query params */ }

  if (!titulo.trim()) return c.json({ error: "falta 'titulo'" }, 400);
  const dest = to || (c.env as any).DOCTOR_WHATSAPP_NUMBER || "";
  if (!dest) {
    return c.json({ error: "no hay destino: manda ?to= o configura el secret DOCTOR_WHATSAPP_NUMBER" }, 400);
  }

  const { sendPersonalReminder } = await import("./whatsapp");
  const r = await sendPersonalReminder(c.env, dest, titulo.trim(), detalle.trim());
  return c.json({
    ok: r.ok,
    via: r.via,
    to: dest,
    error: r.ok ? undefined : (r.data?.error?.message ?? `HTTP ${r.status}`),
  });
});

/**
 * Enviar un DOCUMENTO a un paciente por WhatsApp. Pensado para llamarse desde
 * la app de historia clínica.
 *
 *   POST /wa/send-document?token=<CAPTURE_TOKEN>&to=3001234567
 *        &filename=resultados.pdf&caption=Sus%20resultados
 *   Content-Type: application/pdf   (o image/jpeg, image/png…)
 *   body: el archivo en binario
 *
 * Resuelve solo la ventana de 24h: manda el documento directo y, si Meta lo
 * rechaza por la ventana, cae a la plantilla `documento_paciente`.
 * Responde { ok, via: "directo" | "plantilla", to }.
 */
app.post("/wa/send-document", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const rawTo = c.req.query("to") ?? "";
  const { normalizeColombianPhone, sendDocumentSmart } = await import("./whatsapp");
  const to = normalizeColombianPhone(rawTo);
  if (!to || to.length < 10) return c.json({ error: "falta ?to=<telefono>" }, 400);

  const mime = c.req.header("content-type") || "application/pdf";
  const buf = await c.req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return c.json({ error: "body vacío: manda el archivo en binario" }, 400);
  if (buf.byteLength > 15 * 1024 * 1024) return c.json({ error: "archivo > 15MB" }, 400);

  const filename = c.req.query("filename") ?? (mime.includes("pdf") ? "documento.pdf" : "archivo");
  const caption = c.req.query("caption") ?? "";

  const { uploadWAMedia } = await import("./whatsappMedia");
  const mediaId = await uploadWAMedia(c.env, buf, mime, filename);
  if (!mediaId) return c.json({ error: "WhatsApp rechazó el archivo (¿tipo no permitido?)", mime }, 502);

  const kind = mime.startsWith("image/") ? "image" as const : "document" as const;
  const r = await sendDocumentSmart(c.env, to, mediaId, filename, caption, kind);
  return c.json({
    ok: r.ok, via: r.via, to, filename, bytes: buf.byteLength,
    error: r.ok ? undefined : (r.data?.error?.message ?? `HTTP ${r.status}`),
  });
});
app.get("/wa/phone-info", handlePhoneInfo);

// Asset hosting mínimo: guardar/servir una imagen (ej. avatar) desde KV.
// Permite subir la foto de perfil sin depender de un host externo.
//   POST /wa/asset?token=<CAPTURE_TOKEN>&name=avatar  body: PNG/JPEG binario
//   GET  /wa/asset/avatar                              → sirve la imagen (público)
app.post("/wa/asset", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const name = (c.req.query("name") || "avatar").replace(/[^a-z0-9_-]/gi, "");
  const ct = c.req.header("content-type") || "image/png";
  const buf = await c.req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (buf.byteLength > 5 * 1024 * 1024) return c.json({ error: "too large (>5MB)" }, 400);
  // base64 por chunks (spread completo sobre 100KB+ revienta el call stack)
  const u8 = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  await c.env.STATE.put(`asset:${name}`, JSON.stringify({ ct, b64 }), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 días: suficiente para que Meta lo descargue
  });
  return c.json({ ok: true, name, bytes: buf.byteLength, url: `/wa/asset/${name}` });
});
// Medición de duración del token: set/clear del flag + sonda de estado.
//   GET /debug/measure?token=..&action=start  → activa flag, marca inicio
//   GET /debug/measure?token=..&action=stop   → limpia flag
//   GET /debug/measure?token=..&action=probe  → hace 1 ping read-only a Bukeala
//        y devuelve {ageMin, status, alive} SIN renovar.
app.get("/debug/measure", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const action = c.req.query("action") || "probe";
  if (action === "start") {
    await c.env.STATE.put("debug:measureToken", String(Date.now()), { expirationTtl: 60 * 60 });
    return c.json({ ok: true, measureMode: "ON", note: "preventive refresh pausado 60min" });
  }
  if (action === "stop") {
    await c.env.STATE.delete("debug:measureToken");
    return c.json({ ok: true, measureMode: "OFF" });
  }
  if (action === "cookies") {
    const s = await loadSession(c.env);
    if (!s) return c.json({ note: "no session" });
    // contar por nombre + listar para ver acumulacion
    const counts: Record<string, number> = {};
    for (const ck of s.cookies) counts[ck.name] = (counts[ck.name] || 0) + 1;
    const jsess = s.cookies.filter((ck) => ck.name === "JSESSIONID")
      .map((ck) => ({ path: ck.path, domain: ck.domain, val: ck.value.slice(0, 12) }));
    return c.json({
      total: s.cookies.length,
      capturedAt: s.capturedAt,
      uniqueNames: Object.keys(counts).length,
      duplicates: Object.entries(counts).filter(([, n]) => n > 1),
      jsessionids: jsess,
      allNames: s.cookies.map((ck) => ck.name),
    });
  }
  // probe: medir edad + estado sin renovar
  const s = await loadSession(c.env);
  if (!s) return c.json({ alive: false, ageMin: null, note: "no session" });
  const ageMin = (Date.now() - new Date(s.capturedAt).getTime()) / 60000;
  let status = 0;
  try {
    const b = new Bukeala(c.env);
    const r = await b.findCustomerPage();
    status = r.status;
    await r.text();
  } catch (e) {
    return c.json({ alive: false, ageMin: +ageMin.toFixed(2), status: "expired", err: (e as Error).message.slice(0, 60) });
  }
  return c.json({ alive: status === 200, ageMin: +ageMin.toFixed(2), status, cookies: s.cookies.length });
});

app.get("/wa/asset/:name", async (c) => {
  const name = c.req.param("name").replace(/[^a-z0-9_-]/gi, "");
  const raw = await c.env.STATE.get(`asset:${name}`);
  if (!raw) return c.text("not found", 404);
  const { ct, b64 } = JSON.parse(raw);
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": ct, "cache-control": "public, max-age=3600" } });
});

// Instagram Messaging webhook (Meta Graph API → Worker)
//   GET  → verificación handshake (hub.verify_token debe coincidir con IG_VERIFY_TOKEN)
//   POST → DMs entrantes + delivery statuses
// Setup:
//   1) Cuenta IG Business + Página FB conectada
//   2) Meta App con permisos instagram_basic + instagram_manage_messages
//   3) wrangler secret put IG_ACCESS_TOKEN
//   4) wrangler secret put IG_BUSINESS_ACCOUNT_ID
//   5) wrangler secret put IG_VERIFY_TOKEN
//   6) En Meta App → Instagram → Webhooks → URL: https://<worker>/ig/webhook, verify token = IG_VERIFY_TOKEN
app.get("/ig/webhook", verifyInstagramWebhook);
app.post("/ig/webhook", handleInstagramWebhook);
// Discovery: usa WA_TOKEN para listar pages + IG accounts disponibles
app.get("/ig/discover", handleIgDiscover);

// Dev/debug: dispara manualmente un refresh request (equivalente a /sesion_renew Telegram).
// Útil para test desde curl. Auth via CAPTURE_TOKEN.
app.get("/sesion/renew", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await requestRefresh(c.env, c.req.query("by") ?? "manual-curl");
  return c.json({ ok: true, message: "refresh request queued; watcher picks up in ~30s" });
});

// =====================================================================
// /relay/wa  →  endpoint para que sistemas externos reenvíen mensajes WA
//              a través de este bot. Soporta texto, plantillas, imagen,
//              PDF/documento, video, audio. Multimedia + texto en 1 sola call.
//
// Auth: CAPTURE_TOKEN en query o header X-Capture-Token.
//
// Body JSON acepta cualquier combinación:
//   {
//     "to": "573208336978",                 // requerido
//     "text": "Alerta: paciente X",         // opcional (caption si hay media)
//     "mediaUrl": "https://.../doc.pdf",    // opcional (url pública del archivo)
//     "mediaType": "document",              // opcional: image|document|audio|video (auto-detecta por URL)
//     "filename": "descripcion.pdf",        // opcional (para document)
//     "template": "appointment_reminder",   // opcional (para fuera de 24h)
//     "language": "es_CO",                  // opcional (con template)
//     "params": ["Juan", "..."]             // opcional (con template)
//   }
//
// Si hay mediaUrl: descarga + sube a Meta + envía como media con caption.
// Si hay text sin media: envía como texto libre.
// Si hay template: envía template (cualquier hora, sin necesidad de ventana 24h).
//
// Response: { ok, status, to, sent, data }
// =====================================================================
const handleRelay = async (c: any) => {
  const token = c.req.query("token") || c.req.header("X-Capture-Token");
  if (token !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let to = c.req.query("to") ?? "";
  let text = c.req.query("text") ?? "";
  let mediaUrl = c.req.query("mediaUrl") ?? "";
  let mediaType = c.req.query("mediaType") ?? "";
  let filename = c.req.query("filename") ?? "";
  let template: string | undefined;
  let language: string | undefined;
  let params: string[] | undefined;

  // Si viene body JSON, override query params
  if (c.req.method === "POST") {
    try {
      const body = (await c.req.json()) as any;
      if (body.to) to = String(body.to);
      if (body.text) text = String(body.text);
      if (body.mediaUrl) mediaUrl = String(body.mediaUrl);
      if (body.mediaType) mediaType = String(body.mediaType);
      if (body.filename) filename = String(body.filename);
      if (body.template) template = String(body.template);
      if (body.language) language = String(body.language);
      if (body.params) params = body.params;
    } catch { /* ignore */ }
  }

  // Normalizar número
  const cleanTo = String(to).replace(/\D/g, "");
  if (cleanTo.length < 10) {
    return c.json({ error: "to required (10+ digits)" }, 400);
  }
  const e164 = cleanTo.startsWith("57") && cleanTo.length === 12
    ? cleanTo
    : cleanTo.length === 10 ? "57" + cleanTo : cleanTo;

  const { sendText, sendTemplate } = await import("./whatsapp");

  // === Modo TEMPLATE ===
  if (template) {
    const lang = language ?? "es_CO";
    const bodyParams = (params ?? []).map((p) => ({ type: "text" as const, text: String(p) }));
    const result = await sendTemplate(c.env, e164, template, lang, bodyParams);
    return c.json({ ok: result.ok, status: result.status, to: e164, sent: `template:${template}`, data: result.data }, result.ok ? 200 : 400);
  }

  // === Modo MULTIMEDIA (image/document/audio/video) ===
  if (mediaUrl) {
    const { uploadWAMedia, sendWAMedia } = await import("./whatsappMedia");
    const results: Array<{ step: string; ok: boolean; data?: any }> = [];

    try {
      // Auto-detectar mediaType por extensión si no se proporcionó
      if (!mediaType) {
        const url = mediaUrl.toLowerCase();
        if (/\.(pdf|doc|docx|xls|xlsx|txt)(\?|$)/.test(url)) mediaType = "document";
        else if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/.test(url)) mediaType = "image";
        else if (/\.(mp4|mov|avi)(\?|$)/.test(url)) mediaType = "video";
        else if (/\.(mp3|m4a|ogg|opus|wav)(\?|$)/.test(url)) mediaType = "audio";
        else mediaType = "document"; // fallback safe
      }

      // Descargar archivo
      console.log(`[relay] downloading ${mediaUrl} as ${mediaType}`);
      const fileRes = await fetch(mediaUrl);
      if (!fileRes.ok) {
        return c.json({ error: `failed to download mediaUrl: ${fileRes.status}` }, 400);
      }
      const buffer = await fileRes.arrayBuffer();
      let mime = fileRes.headers.get("content-type") ?? "application/octet-stream";
      if (mime === "application/octet-stream" || mime.startsWith("text/")) {
        // Inferir MIME por extensión si el server no lo dijo bien
        const ext = mediaUrl.split(".").pop()?.toLowerCase().split("?")[0] ?? "";
        const map: Record<string, string> = {
          pdf: "application/pdf",
          doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
          mp4: "video/mp4", mov: "video/quicktime",
          mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4",
        };
        if (map[ext]) mime = map[ext];
      }
      // Filename para document (si no viene)
      if (!filename) {
        filename = mediaUrl.split("/").pop()?.split("?")[0] ?? "archivo";
      }

      // Subir a Meta
      const mediaId = await uploadWAMedia(c.env, buffer, mime, filename);
      if (!mediaId) {
        return c.json({ error: "media upload to WhatsApp failed" }, 500);
      }
      results.push({ step: "upload", ok: true, data: { mediaId, bytes: buffer.byteLength } });

      // Enviar mensaje con media + caption (text)
      const wa = await sendWAMedia(
        c.env,
        e164,
        mediaType as "image" | "document" | "audio" | "video",
        mediaId,
        text || undefined,
        mediaType === "document" ? filename : undefined,
      );
      results.push({ step: "send_media", ok: wa.ok, data: wa.data });

      return c.json({
        ok: wa.ok,
        status: wa.status,
        to: e164,
        sent: `${mediaType}${text ? "+caption" : ""}`,
        media: { type: mediaType, filename, bytes: buffer.byteLength },
        data: wa.data,
      }, wa.ok ? 200 : 400);
    } catch (e) {
      return c.json({ error: (e as Error).message, partial: results }, 500);
    }
  }

  // === Modo TEXTO LIBRE ===
  if (text) {
    const result = await sendText(c.env, e164, text);
    return c.json({ ok: result.ok, status: result.status, to: e164, sent: "text", data: result.data }, result.ok ? 200 : 400);
  }

  return c.json({ error: "must provide one of: text, mediaUrl, or template" }, 400);
};
app.get("/relay/wa", handleRelay);
app.post("/relay/wa", handleRelay);

// QR code redirect: abre WhatsApp con mensaje pre-llenado
//   /qr      → QR del wa.me link (PNG 600x600)
//   /wa.me   → redirect a wa.me con mensaje pre-llenado (úsalo en redes, bio, etc.)
app.get("/wa.me", (c) => {
  const text = c.req.query("text") ?? "Hola Dr. Duque, quiero agendar una cita";
  return c.redirect(`https://wa.me/573209488164?text=${encodeURIComponent(text)}`);
});
// Dashboard web — vista en vivo de hoy/mañana/WA/cotizaciones
//   /dashboard?token=<CAPTURE_TOKEN>  → HTML auto-refresh cada 30s
app.get("/dashboard", handleDashboard);
// Panel visual en vivo (versión "vendible" del dashboard). Datos reales.
app.get("/panel", handlePanel);

app.get("/qr", (c) => {
  const size = c.req.query("size") ?? "600x600";
  const text = c.req.query("text") ?? "Hola Dr. Duque, quiero agendar una cita";
  const waUrl = `https://wa.me/573209488164?text=${encodeURIComponent(text)}`;
  return c.redirect(
    `https://api.qrserver.com/v1/create-qr-code/?size=${size}&data=${encodeURIComponent(waUrl)}&margin=20`,
  );
});

// Botón flotante WhatsApp para incluir en davidduque.com (u otras webs)
// Uso (en el HTML, antes de </body>):
//   <script src="https://bukeala-bot.ddropero.workers.dev/js/wa-button.js" async></script>
// Personalización opcional (data-attrs en el script):
//   <script src=".../wa-button.js" data-text="Hola, info de rinoplastia" data-position="left" async></script>
app.get("/js/wa-button.js", (c) => {
  const js = `(function(){
  var s=document.currentScript;
  var defaultText="Hola Dr. Duque, quiero agendar una cita de valoración";
  var text=(s&&s.dataset.text)||defaultText;
  var pos=(s&&s.dataset.position==="left")?"left":"right";
  var phone=(s&&s.dataset.phone)||"573209488164";
  var url="https://wa.me/"+phone+"?text="+encodeURIComponent(text);
  var css=".wa-fab{position:fixed;bottom:24px;"+pos+":24px;width:60px;height:60px;background:#25D366;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:99999;text-decoration:none;transition:transform .2s,box-shadow .2s;cursor:pointer}"
  +".wa-fab:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(0,0,0,0.25)}"
  +".wa-fab::after{content:'';position:absolute;width:60px;height:60px;border-radius:50%;background:#25D366;opacity:.6;animation:wa-pulse 1.5s ease-out infinite;z-index:-1}"
  +"@keyframes wa-pulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.6);opacity:0}}"
  +"@media (max-width:600px){.wa-fab{bottom:16px;"+pos+":16px;width:56px;height:56px}.wa-fab svg{width:28px;height:28px}}";
  var styleEl=document.createElement("style");styleEl.textContent=css;document.head.appendChild(styleEl);
  var a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener";a.className="wa-fab";a.setAttribute("aria-label","Escribir por WhatsApp");
  a.innerHTML='<svg viewBox="0 0 24 24" width="32" height="32" fill="#fff"><path d="M20.52 3.48A11.93 11.93 0 0 0 12.04 0C5.4 0 .04 5.36.04 12c0 2.11.55 4.16 1.6 5.97L0 24l6.18-1.62a11.96 11.96 0 0 0 5.86 1.5h.01c6.62 0 11.99-5.37 12-12 0-3.2-1.25-6.21-3.53-8.4zm-8.48 18.4h-.01a9.94 9.94 0 0 1-5.07-1.39l-.36-.22-3.67.96.98-3.58-.24-.37a9.94 9.94 0 0 1-1.52-5.28c0-5.5 4.48-9.97 9.99-9.97 2.67 0 5.18 1.04 7.07 2.93a9.93 9.93 0 0 1 2.92 7.06c0 5.5-4.48 9.96-10.09 9.96zm5.48-7.45c-.3-.15-1.77-.87-2.05-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51l-.57-.01c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.06 2.87 1.21 3.07.15.2 2.1 3.2 5.07 4.49.71.3 1.26.48 1.7.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/></svg>';
  function inject(){document.body.appendChild(a)}
  if(document.body)inject();else document.addEventListener("DOMContentLoaded",inject);
})();`;
  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Debug endpoints (auth via ?token=<CAPTURE_TOKEN>)
//   /debug/branches
//   /debug/components
//   /debug/areaHints?componentCode=...
//   /debug/search?date=DD/MM/YYYY&componentCode=...
//   /debug/customer?type=C&id=...
//   /debug/myBookings
// Telemetría de sesión/renovación acumulada. Responde con datos reales:
// cuánto viven los JSESSIONID (sessionLifetimes), cuánto vive el TGC
// (tgcLifetimesMin = gap entre logins con captcha), captchas/día
// (renewCounters) y el estado actual. Auth igual que /debug/:resource.
app.get("/debug/session-stats", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const parse = (r: string | null) => { try { return r ? JSON.parse(r) : null; } catch { return null; } };

  const [lifetimesRaw, tgcRaw, lastCaptchaRaw, lastGoodRaw, pendingRaw, zeroBalanceRaw] = await Promise.all([
    c.env.STATE.get("stats:sessionLifetimes"),
    c.env.STATE.get("stats:tgcLifetimes"),
    c.env.STATE.get("stats:lastCaptchaOkAt"),
    c.env.STATE.get("keepalive:lastGood"),
    c.env.STATE.get("wa:pending:list"),
    c.env.STATE.get("nativeHost:zeroBalanceAlertAt"),
  ]);
  const session = await loadSession(c.env);

  // Contadores de hoy y ayer (UTC) por vía de renovación
  const days = [0, 1].map((d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
  // "ok:alive" = renovación en sitio con el navegador vivo (0 captchas).
  const buckets = ["ok:alive", "ok:tgc", "ok:captcha", "ok:captcha-fallback", "ok:unknown", "error"];
  const renewCounters: Record<string, Record<string, number>> = {};
  for (const day of days) {
    renewCounters[day] = {};
    for (const bucket of buckets) {
      const v = await c.env.STATE.get(`stats:renew:${day}:${bucket}`);
      if (v) renewCounters[day][bucket] = parseInt(v, 10) || 0;
    }
  }

  const hasTgc = (name: string) => name.toUpperCase().startsWith("TGC") || name.toUpperCase().startsWith("CASTGC");
  return c.json({
    session: session
      ? {
          capturedAt: session.capturedAt,
          ageMin: Math.round((Date.now() - new Date(session.capturedAt).getTime()) / 60000),
          cookieCount: session.cookies.length,
          hasTgc: session.cookies.some((k) => hasTgc(k.name)),
        }
      : null,
    sessionLifetimes: parse(lifetimesRaw),
    tgcLifetimesMin: parse(tgcRaw),
    lastCaptchaOkAt: lastCaptchaRaw ? new Date(parseInt(lastCaptchaRaw, 10)).toISOString() : null,
    keepaliveLastGood: parse(lastGoodRaw),
    pendingQueue: ((parse(pendingRaw) as unknown[]) ?? []).length,
    lastZeroBalanceAlertAt: zeroBalanceRaw ? new Date(parseInt(zeroBalanceRaw, 10)).toISOString() : null,
    renewCounters,
  });
});

// Prueba de envío de WhatsApp que devuelve la respuesta CRUDA de Meta.
// Sirve para diagnosticar 132001 y compañía sin adivinar: manda la
// confirmación real y expone status + error tal cual los da Meta.
//   GET /debug/wa-test?token=..&to=573..&name=..&date=..&time=..&place=..
app.get("/debug/wa-test", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const to = c.req.query("to");
  if (!to) return c.json({ error: "falta ?to=<numero>" }, 400);
  const name = c.req.query("name") ?? "Paciente";
  const date = c.req.query("date") ?? "Lunes 04/08/26";
  const time = c.req.query("time") ?? "10:00 AM";
  const place = c.req.query("place") ?? "Calle 80 # 10-43, Cons 506";
  const wa = await import("./whatsapp");

  // ?mode=botones prueba la plantilla confirmar_cita (Quick Reply), que es el
  // flujo de "confirmar cita"; sin él prueba la confirmación post-agendamiento.
  if (c.req.query("mode") === "botones") {
    const r = await wa.sendAppointmentConfirmRequest(c.env, to, name, date, time, place);
    return c.json({ enviado: r.ok, via: (r as any).mode, status: (r as any).status, metaResponse: (r as any).data });
  }
  const r = await wa.sendAppointmentConfirmation(c.env, to, name, date, time, place);
  return c.json({ enviado: r.ok, status: r.status, reason: r.reason, metaResponse: r.data });
});

// Devuelve la agenda como PDF (para revisar el formato antes de enviarlo).
//   GET /debug/agenda-pdf?token=..&date=DD-MM-YYYY
app.get("/debug/agenda-pdf", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const date = c.req.query("date");
  if (!date) return c.json({ error: "falta ?date=DD-MM-YYYY" }, 400);
  const { Bukeala } = await import("./bukeala");
  const { buildAgendaPdfDoc } = await import("./agendaDoc");
  const { buildAgendaPdf } = await import("./agendaPdf");
  const b = new Bukeala(c.env);
  const res = await b.getAgenda(date, 1074, false);
  const json = await res.json<any>().catch(() => null);
  const bookings = json?.areas?.[0]?.bookings ?? [];
  const friendly = json?.defaultDateFormatted ?? date;
  const { title, lines } = buildAgendaPdfDoc(bookings, friendly);
  const pdf = buildAgendaPdf(title, lines);
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="agenda-${date}.pdf"`,
    },
  });
});

// Diagnóstico de la app de Meta: app_id y scopes del WA_TOKEN. El app_id hace
// falta para la Resumable Upload API (subir el archivo de muestra que Meta
// exige al crear una plantilla con cabecera de DOCUMENTO).
app.get("/debug/wa-appinfo", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const t = encodeURIComponent(c.env.WA_TOKEN);
  const res = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${t}&access_token=${t}`);
  const d = await res.json<any>().catch(() => ({}));
  return c.json({
    appId: d?.data?.app_id,
    app: d?.data?.application,
    type: d?.data?.type,
    expiresAt: d?.data?.expires_at,
    scopes: d?.data?.scopes,
    granular: d?.data?.granular_scopes,
  });
});

/**
 * ¿Bukeala expone el TELÉFONO y el EMAIL del paciente en algún lado?
 *
 * La API de agenda NO los trae (solo `isValidColombianCellPhone`). Pero el
 * formulario de agendamiento los pide, así que puede venir PRELLENADO con los
 * datos del cliente — y para eso hay que SELECCIONAR al paciente primero
 * (findCustomer/{tipo}/{id}) y solo después leer la página.
 *
 *   GET /debug/customer-contact?token=..&type=1&id=63438331
 */
app.get("/debug/customer-contact", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const idType = c.req.query("type") ?? "1";
  const id = c.req.query("id");
  if (!id) return c.json({ error: "falta ?id=<cedula>" }, 400);

  const b = new Bukeala(c.env);
  const out: any = { idType, id };
  try {
    const sel = await b.selectCustomer(idType, id);
    out.selectStatus = sel.status;
    await sel.text().catch(() => "");

    const page = await b.findAvailabilityPage();
    out.pageStatus = page.status;
    const html = await page.text();
    out.pageBytes = html.length;

    // 1) inputs cuyo name/id huele a contacto, con su value
    const inputs: string[] = [];
    const re = /<input[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const tag = m[0];
      if (!/(mail|phone|cel|tel|contact)/i.test(tag)) continue;
      const name = (tag.match(/(?:name|id)\s*=\s*"([^"]*)"/i) ?? [])[1] ?? "?";
      const value = (tag.match(/value\s*=\s*"([^"]*)"/i) ?? [])[1] ?? "";
      inputs.push(`${name}="${value}"`);
    }
    out.inputsContacto = inputs.slice(0, 25);

    // 2) cualquier email y cualquier celular colombiano en el HTML
    out.emailsEnHtml = [...new Set(html.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])]
      .filter((e) => !/tuscitasmedicas|colsanitas|keralty|w3\.org|schema/i.test(e))
      .slice(0, 10);
    out.celularesEnHtml = [...new Set(html.match(/(?<!\d)3\d{9}(?!\d)/g) ?? [])].slice(0, 10);

    // 3) el nombre del paciente, para confirmar que el select funcionó
    out.nombreDetectado = (html.match(/<span\s+class="user-name">([^<]+)<\/span>/) ?? [])[1] ?? null;

    // 3b) La pantalla de "mis citas" del paciente: otra vista, otro HTML — a
    //     veces los portales muestran ahí el contacto de contacto de la cita.
    try {
      const mb = await b.myBookings(false);
      const mbHtml = await mb.text();
      out.myBookings = {
        status: mb.status,
        bytes: mbHtml.length,
        emails: [...new Set(mbHtml.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? [])]
          .filter((e) => !/tuscitasmedicas|colsanitas|keralty|w3\.org|schema|googleapis/i.test(e))
          .slice(0, 8),
        celulares: [...new Set(mbHtml.match(/(?<!\d)3\d{9}(?!\d)/g) ?? [])].slice(0, 8),
        // etiquetas visibles, para ver qué campos muestra esa pantalla
        etiquetas: [...new Set([...mbHtml.matchAll(/<p class="([a-z-]+)">/gi)].map((m2) => m2[1]))].slice(0, 20),
      };
    } catch (e) {
      out.myBookings = { error: (e as Error).message };
    }

    // 4) TODO el bloque de datos del paciente: es donde el bot ya lee tipo de
    //    documento y sexo, así que si el teléfono/email existen, están acá.
    const bloque = html.match(/user-data[\s\S]{0,4000}/i);
    if (bloque) {
      const etiquetas = [...bloque[0].matchAll(/<span class="(?:label|title)">([^<]*)<\/span>/gi)].map((x) => x[1].trim());
      const valores = [...bloque[0].matchAll(/<span class="content">([^<]*)<\/span>/gi)].map((x) => x[1].trim());
      out.camposPaciente = { etiquetas: etiquetas.slice(0, 20), valores: valores.slice(0, 20) };
    } else {
      out.camposPaciente = null;
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  return c.json(out);
});

/**
 * Directorio de contactos: sembrar y consultar. SIN enviar nada.
 *   GET /debug/contactos?token=..&backfill=1   → siembra desde KV existente
 *   GET /debug/contactos?token=..&cedula=..    → consulta uno
 */
app.get("/debug/contactos", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const { backfillContactos, getContacto } = await import("./pacientesContacto");
  const out: any = {};
  if (c.req.query("backfill")) out.backfill = await backfillContactos(c.env);
  const cc = c.req.query("cedula");
  if (cc) out.contacto = await getContacto(c.env, cc);
  // Cuántos hay en total
  let total = 0, cursor: string | undefined;
  do {
    const res: any = await c.env.STATE.list({ prefix: "paciente:contacto:", cursor });
    total += (res.keys ?? []).length;
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  out.totalEnDirectorio = total;
  return c.json(out);
});

/**
 * Vista previa del TEXTO que se le mandaría a la secretaria, sin enviarlo.
 * Sirve para revisar el formato con contactos reales sin gastar mensajes.
 *   GET /debug/agenda-preview?token=..&date=DD-MM-YYYY
 */
app.get("/debug/agenda-preview", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const date = c.req.query("date");
  if (!date) return c.json({ error: "falta ?date=DD-MM-YYYY" }, 400);
  const { buildAgendaText } = await import("./agendaDoc");
  const { getContactos } = await import("./pacientesContacto");
  // Misma fuente que usan los crons: Calendar (EPS + particular), no Bukeala.
  const { leerAgendaDelDia } = await import("./agendaFuente");
  const lectura = await leerAgendaDelDia(c.env, date);
  const bookings = lectura.bookings;
  const activos = bookings.filter((bk: any) => !bk?.isCanceled && bk?.stateCode !== "CANCELED" && !bk?.isBusyTime);
  const dir = await getContactos(c.env, activos.map((bk: any) => bk.identification ?? ""));
  return new Response(buildAgendaText(bookings, date, dir), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
});

// Diagnóstico: qué devuelve getAgenda para una fecha (sin enviar nada).
//   GET /debug/agenda-raw?token=..&date=DD-MM-YYYY
app.get("/debug/agenda-raw", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const date = c.req.query("date");
  if (!date) return c.json({ error: "falta ?date=DD-MM-YYYY" }, 400);
  const { Bukeala } = await import("./bukeala");
  const b = new Bukeala(c.env);
  const res = await b.getAgenda(date, 1074, false);
  const json = await res.json<any>().catch(() => null);
  const areas = json?.areas ?? [];
  return c.json({
    httpStatus: res.status,
    clavesTopLevel: json ? Object.keys(json) : null,
    defaultDateFormatted: json?.defaultDateFormatted,
    numAreas: areas.length,
    areas: areas.map((a: any) => ({
      areaId: a?.id ?? a?.areaId,
      nombre: a?.name ?? a?.areaName,
      numBookings: (a?.bookings ?? []).length,
    })),
    muestraBooking: areas?.[0]?.bookings?.[0] ?? null,
  });
});

// Prueba manual del envío de la agenda a la secretaria por WhatsApp.
// ?to=573... limita el envío a esos números (y no toca Telegram), para
// verificar la cadena completa sin escribirle a la secretaria fuera de hora.
app.get("/debug/agenda-secretaria", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const to = (c.req.query("to") ?? "").split(",").map((s) => s.replace(/\D/g, "")).filter((s) => s.length >= 10);
  if (to.length === 0) return c.json({ error: "falta ?to=<numero[,numero]>" }, 400);
  // ?date=DD-MM-YYYY para revisar el formato con un día que sí tenga citas.
  const date = c.req.query("date");
  const r = await secretaryAgendaCron(c.env, { testWaOnly: to, dateDashed: date });
  return c.json({ probado: to, fecha: date ?? "mañana", resultado: r ?? "sin sesión de Bukeala" });
});

// Espejo Bukeala → Google Calendar a demanda (mismo código que el cron de
// cada 2h). Devuelve el resumen en JSON; sirve para probar con curl.
//   ?dias=N    ventana desde hoy (1–60, default 14)
//   ?forzar=1  salta el tope de cancelaciones (solo si sabes que son reales)
// no-store: las respuestas GET pueden quedar cacheadas en el edge y aquí cada
// llamada ES una sincronización distinta.
//   ?autoprueba=1  NO toca Bukeala ni el calendario del Dr.: ejercita la
//                  sincronización con citas sintéticas en un calendario
//                  temporal del service account (ver cron/espejoCalendarPrueba.ts)
app.get("/debug/espejo-calendar", async (c) => {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (c.req.query("autoprueba") === "1") {
    const { autoPruebaEspejo } = await import("./cron/espejoCalendarPrueba");
    const rep = await autoPruebaEspejo(c.env);
    return c.json(rep, rep.ok ? 200 : 500, { "Cache-Control": "no-store" });
  }
  const diasRaw = parseInt(c.req.query("dias") ?? "", 10);
  const r = await espejoCalendarCron(c.env, {
    dias: Number.isFinite(diasRaw) ? diasRaw : undefined,
    forzarCancelaciones: c.req.query("forzar") === "1",
    origen: "manual",
  });
  return c.json(r, 200, { "Cache-Control": "no-store" });
});

app.get("/debug/:resource", handleDebug);

// Keep-alive cron:
//   1. Hits a lightweight Bukeala endpoint with the stored session, both
//      to keep the Java session timer alive AND to detect expiry early.
//   2. On expiry, sends a Telegram message to the user so they know to
//      re-capture from the browser extension. We use KV to throttle so
//      we don't spam (one notice per "expiry event").
async function keepAlive(env: Env): Promise<void> {
  const s = await loadSession(env);
  if (!s) {
    // Sin sesión en KV. Antes esto retornaba mudo, así que si la VM dejaba de
    // empujar (apagada, colgada) el blob expiraba a las 12h y nadie se
    // enteraba: /agenda muerto en silencio. Ahora pedimos renovación.
    console.log("[keepalive] sin sesión en KV → pidiendo renovación");
    const lastNoSession = await env.STATE.get("keepalive:noSessionRefreshAt");
    if (!lastNoSession || Date.now() - parseInt(lastNoSession, 10) > 10 * 60 * 1000) {
      try {
        await requestRefresh(env, "auto-keepalive-sin-sesion");
        await env.STATE.put("keepalive:noSessionRefreshAt", String(Date.now()), {
          expirationTtl: 60 * 60,
        });
      } catch (e) {
        console.log("[keepalive] refresh sin-sesión falló:", (e as Error).message);
      }
    }
    return;
  }

  // Edad de la sesión en minutos
  const ageMin = (Date.now() - new Date(s.capturedAt).getTime()) / 60000;
  console.log(`[keepalive] session age=${ageMin.toFixed(1)}min, cookies=${s.cookies.length}`);

  // MODO 24/7 (desde 29/jul/2026): la VM renueva con "navegador vivo" sin
  // gastar captcha, así que el viejo modo bajo demanda (dejar morir la sesión
  // para ahorrar 2Captcha) ya no aplica. Este keepAlive pingea para mantener
  // viva la sesión y, si la encuentra muerta, dispara recuperación SIEMPRE.

  const b = new Bukeala(env);
  try {
    // Doble ping: findCustomerPage + findAvailabilityPage — actividad genuina
    // en ambos servlets (ambos comparten la JVM session, pero hacer 2 calls
    // refuerza el "session is alive" en el backend).
    const r1 = await b.findCustomerPage();
    await r1.text();
    console.log(`[keepalive] /findCustomer → ${r1.status}`);

    try {
      const r2 = await b.findAvailabilityPage();
      await r2.text();
      console.log(`[keepalive] /findAvailability → ${r2.status}`);
    } catch (e2) {
      // No bloqueante — la idea es que si una funciona, la otra puede fallar
      console.log("[keepalive] findAvailability falló (no crítico):", (e2 as Error).message);
    }

    // Telemetría: recordar el último ping OK de ESTA sesión (por capturedAt)
    // para medir su vida real cuando muera → stats:sessionLifetimes.
    try {
      await env.STATE.put(
        "keepalive:lastGood",
        JSON.stringify({ at: Date.now(), capturedAt: s.capturedAt }),
        { expirationTtl: 60 * 60 * 24 },
      );
    } catch { /* telemetría no bloqueante */ }

    // Reset the "notified" flag SOLO si llevábamos un rato realmente caídos
    // (recuperación genuina), no en cada éxito. La sesión a veces fluctúa
    // 200/302 entre pings; si borráramos el flag con cada 200, el siguiente
    // 302 dispararía otro aviso → spam. Solo limpiamos si el último aviso fue
    // hace > 20 min (señal de que fue una caída real ya resuelta).
    const notifiedAt = await env.STATE.get("keepalive:notifiedAt");
    if (notifiedAt && Date.now() - parseInt(notifiedAt, 10) > 20 * 60 * 1000) {
      await env.STATE.delete("keepalive:notified");
      await env.STATE.delete("keepalive:notifiedAt");
    }

    // If the pending queue is non-empty AND we just confirmed Bukeala is alive,
    // process the queue: this catches the "session recovered without an explicit
    // refresh event" case (e.g. a fresh capture from the extension).
    try {
      const pending = await loadPendingRequests(env);
      if (pending.length > 0) {
        console.log(`[keepalive] processing ${pending.length} pending WhatsApp requests`);
        await processPendingRequests(env);
      }
    } catch (e) {
      console.log("[keepalive] pending-queue process failed:", (e as Error).message);
    }
  } catch (e) {
    if (!(e instanceof SessionExpiredError)) {
      console.log("[keepalive] unexpected error:", (e as Error).message);
      return;
    }
    console.log("[keepalive] session expired");

    // Telemetría: si ESTA misma sesión tuvo un ping OK antes, registrar cuánto
    // vivió realmente (responde "¿cuánto dura el JSESSIONID?" con datos).
    try {
      const lastGoodRaw = await env.STATE.get("keepalive:lastGood");
      if (lastGoodRaw) {
        const lastGood = JSON.parse(lastGoodRaw) as { at: number; capturedAt: string };
        if (lastGood.capturedAt === s.capturedAt) {
          const now = Date.now();
          const lifeMin = Math.round((now - new Date(s.capturedAt).getTime()) / 6000) / 10;
          const sinceOkMin = Math.round((now - lastGood.at) / 6000) / 10;
          let lifes: Array<{ capturedAt: string; lifeMin: number; sinceOkMin: number }> = [];
          try { lifes = JSON.parse((await env.STATE.get("stats:sessionLifetimes")) ?? "[]"); } catch { /* ignore */ }
          lifes.push({ capturedAt: s.capturedAt, lifeMin, sinceOkMin });
          await env.STATE.put("stats:sessionLifetimes", JSON.stringify(lifes.slice(-100)), {
            expirationTtl: 60 * 60 * 24 * 90,
          });
          await env.STATE.delete("keepalive:lastGood");
          console.log(`[keepalive] sesión vivió ${lifeMin} min (último OK hace ${sinceOkMin} min)`);
        }
      }
    } catch (e) {
      console.log("[keepalive] lifetime tracking failed:", (e as Error).message);
    }

    // 24/7: renovar SIEMPRE que la sesión esté caída, haya o no pacientes en
    // cola. Antes solo se renovaba con cola no vacía ("ahorro de captcha"), y
    // eso dejaba /agenda muerto hasta que la VM lo notara en su siguiente tick
    // (hasta 10 min). Con el navegador vivo renovar es gratis, así que no hay
    // razón para esperar. Throttle de 10 min para no encolar refrescos de más.
    const lastAutoRefreshAt = await env.STATE.get("keepalive:autoRefreshAt");
    const now = Date.now();
    const shouldAutoRefresh =
      !lastAutoRefreshAt || now - parseInt(lastAutoRefreshAt, 10) > 10 * 60 * 1000;
    if (shouldAutoRefresh) {
      try {
        await requestRefresh(env, "auto-keepalive-24-7");
        await env.STATE.put("keepalive:autoRefreshAt", String(now), { expirationTtl: 60 * 60 });
        console.log("[keepalive] refresh disparado (sesión caída, modo 24/7)");
      } catch (e) {
        console.log("[keepalive] auto-refresh request failed:", (e as Error).message);
      }
    }

    // 2) Avisar al doctor. Ya NO se silencia de noche: la VM renueva 24/7, así
    //    que una expiración nocturna es una falla real, no algo esperado.
    // Throttle: máximo 1 aviso cada 30 min (antes borrábamos el flag con cada
    // éxito, lo que causaba spam si la sesión fluctuaba). 30 min da tiempo a
    // que el refresh auto se complete antes de un segundo aviso.
    const alreadyNotified = await env.STATE.get("keepalive:notified");
    if (alreadyNotified) {
      console.log("[keepalive] notice already sent recently, skip");
      return;
    }
    try {
      const doctors = await getDoctorRecipients(env);
      for (const doctorChatId of doctors) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: doctorChatId,
            text:
              "⚠️ <b>Sesión Bukeala expirada</b>\n\n" +
              "🤖 Auto-disparé un refresh. Si no se resuelve en ~2 min, corre /sesion_renew.",
            parse_mode: "HTML",
          }),
        });
      }
      // Flag con TTL 30 min + timestamp para la lógica de limpieza de arriba.
      await env.STATE.put("keepalive:notified", "1", { expirationTtl: 60 * 30 });
      await env.STATE.put("keepalive:notifiedAt", String(Date.now()), { expirationTtl: 60 * 60 });
    } catch (notifyErr) {
      console.log("[keepalive] notify failed:", (notifyErr as Error).message);
    }
  }
}

// OAuthProvider envuelve el Worker: protege /mcp (y /sse legacy) con OAuth,
// implementa /token, /register y los discovery endpoints, y delega todo lo
// demás (Telegram, WhatsApp, /authorize, etc.) al Hono app vía defaultHandler.
const oauth = new OAuthProvider({
  apiHandlers: {
    "/mcp": BukealaMcp.serve("/mcp"),
    "/sse": BukealaMcp.serveSSE("/sse"),
  },
  defaultHandler: app as unknown as ExportedHandler<Env>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch: oauth.fetch.bind(oauth) as ExportedHandler<Env>["fetch"],
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Dispatch by cron schedule
    if (event.cron === "0 12 * * *") {
      ctx.waitUntil(dailySummary(env));
    } else if (event.cron === "0 13 * * *") {
      // 7am Colombia (Sundays-Saturdays): send appointment reminders for tomorrow
      ctx.waitUntil(reminderCron(env));
    } else if (event.cron === "0 18 * * *") {
      // 1 PM Colombia: send tomorrow's agenda (HTML doc) to the secretary
      // via Telegram + WhatsApp.
      ctx.waitUntil(secretaryAgendaCron(env));
    } else if (event.cron === "0 23 * * *") {
      // 6 PM Colombia (todos los días): SEGUNDO recordatorio del día a cada
      // paciente con cita mañana (el primero salió a las 8am vía reminderCron).
      ctx.waitUntil(eveningReminderCron(env));
    } else if (event.cron === "*/10 12-23 * * *") {
      ctx.waitUntil(newBookingsCheck(env));
    } else if (event.cron === "*/15 * * * *") {
      // Cada 15 min 24/7: devolver a IA contactos en manual con 30+ min sin actividad
      ctx.waitUntil(autoReturnToAI(env));
      // + Watchdog: vigila salud de la sesión, alerta si lleva 20+ min caída
      ctx.waitUntil(watchdogCron(env));
    } else if (event.cron === "0 12 * * 1") {
      // Lunes 7am Bogotá: reporte semanal
      ctx.waitUntil(weeklyReport(env));
    } else if (event.cron === "0 14 * * *") {
      // 9am Bogotá diario: follow-up cotizaciones de hace 48h
      ctx.waitUntil(quoteFollowup(env));
    } else if (event.cron === "0 12,14,16,18,20,22 * * *") {
      // Cada 2h en horario de oficina (7am–5pm Bogotá): espejo de la agenda de
      // Bukeala hacia Google Calendar (14 días). Si Bukeala no responde, aborta
      // sin cancelar nada — ver cron/espejoCalendar.ts.
      ctx.waitUntil(espejoCalendarCron(env, { origen: "cron" }));
    } else {
      // Default: keepAlive (cada 3 min)
      ctx.waitUntil(keepAlive(env));
    }
  },
};
