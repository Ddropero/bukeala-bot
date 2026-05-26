import { Hono } from "hono";
import type { Env } from "./env";
import { handleCapture } from "./handlers/capture";
import { handleTelegramWebhook, setupWebhook } from "./handlers/webhook";
import { handleDebug } from "./handlers/debug";
import { verifyWhatsAppWebhook, handleWhatsAppWebhook } from "./handlers/whatsappWebhook";
import { verifyInstagramWebhook, handleInstagramWebhook } from "./handlers/instagramWebhook";
import { handleIgDiscover } from "./handlers/instagramDiscover";
import { handleGetProfile, handleUpdateProfilePicture, handlePhoneInfo } from "./handlers/whatsappProfile";
import { handleDashboard } from "./handlers/dashboard";
import { handleNativeHostEvent, handleCheckRefresh, handleRefreshComplete } from "./handlers/nativeHostEvent";
import { Bukeala, SessionExpiredError } from "./bukeala";
import { loadSession } from "./kv";
import { dailySummary } from "./cron/dailySummary";
import { newBookingsCheck } from "./cron/newBookingsWatch";
import { reminderCron } from "./cron/reminderCron";
import { autoReturnToAI } from "./cron/autoReturnToAI";
import { weeklyReport } from "./cron/weeklyReport";
import { quoteFollowup } from "./cron/quoteFollowup";
import { getDoctorRecipients } from "./users";
import { processPendingRequests, loadPendingRequests } from "./claudeBookingAgent";
import { requestRefresh } from "./handlers/nativeHostEvent";
import { handleHandoffWebhook, setupHandoffWebhook } from "./handoffBot";
import { handleQuotesWebhook, setupQuotesWebhook } from "./quotesBot";

// Re-export the Durable Object class so wrangler can find it.
export { BukealaProxy } from "./proxy";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Bukeala bot worker — alive"));

// Cookie capture from the browser extension
app.post("/capture", handleCapture);

// Native Host event reporter (success / TGC expired / errors)
app.post("/native-host/event", handleNativeHostEvent);

// Native Host watcher polling endpoint — checks if /sesion_renew was requested
app.get("/native-host/check-refresh", handleCheckRefresh);

// Native Host reports back when refresh completed (success/fail) → notifies requester
app.post("/native-host/refresh-complete", handleRefreshComplete);

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
app.get("/wa/phone-info", handlePhoneInfo);

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
      const body = await c.req.json<any>();
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
    // No session yet — nothing to ping. Don't notify.
    return;
  }

  // Edad de la sesión en minutos
  const ageMin = (Date.now() - new Date(s.capturedAt).getTime()) / 60000;
  console.log(`[keepalive] session age=${ageMin.toFixed(1)}min, cookies=${s.cookies.length}`);

  // PROACTIVE REFRESH: Bukeala mata sesiones a los ~20 min (HARD timeout).
  // Disparamos refresh a los 12 min para tener buffer de seguridad.
  // Throttle 8 min para no spam al watcher (la auto-login toma ~50-90s, así
  // que con throttle 8min nos aseguramos de no dispararla dos veces).
  if (ageMin > 12) {
    const lastAt = await env.STATE.get("keepalive:autoRefreshAt");
    const now = Date.now();
    const shouldRefresh = !lastAt || now - parseInt(lastAt, 10) > 8 * 60 * 1000;
    if (shouldRefresh) {
      try {
        await requestRefresh(env, "auto-keepalive-preventive");
        await env.STATE.put("keepalive:autoRefreshAt", String(now), { expirationTtl: 60 * 60 });
        console.log(`[keepalive] PREVENTIVE refresh disparado (age=${ageMin.toFixed(1)}min)`);
      } catch (e) {
        console.log("[keepalive] preventive refresh failed:", (e as Error).message);
      }
    }
  }

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

    // Reset the "notified" flag so a future expiry triggers a fresh notice
    await env.STATE.delete("keepalive:notified");

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
    console.log("[keepalive] session expired — auto-triggering refresh");

    // 1) Auto-trigger Native Host refresh (it does headless 2Captcha login).
    //    Throttle to once per 10 min so we don't spam the watcher when login itself fails.
    const lastAutoRefreshAt = await env.STATE.get("keepalive:autoRefreshAt");
    const now = Date.now();
    const shouldAutoRefresh =
      !lastAutoRefreshAt || now - parseInt(lastAutoRefreshAt, 10) > 10 * 60 * 1000;
    if (shouldAutoRefresh) {
      try {
        await requestRefresh(env, "auto-keepalive");
        await env.STATE.put("keepalive:autoRefreshAt", String(now), {
          expirationTtl: 60 * 60,
        });
        console.log("[keepalive] auto-refresh queued for Native Host");
      } catch (e) {
        console.log("[keepalive] auto-refresh request failed:", (e as Error).message);
      }
    }

    // 2) Notify the doctor (once per expiry, until session is restored)
    const alreadyNotified = await env.STATE.get("keepalive:notified");
    if (alreadyNotified) {
      console.log("[keepalive] notice already sent for this expiry, skip");
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
              "🤖 Auto-disparé un refresh con el Native Host (2Captcha). " +
              "Si no se resuelve en ~1 min, corre /sesion_renew o <code>node index.js --setup</code>.",
            parse_mode: "HTML",
          }),
        });
      }
      await env.STATE.put("keepalive:notified", "1", { expirationTtl: 60 * 60 * 12 });
    } catch (notifyErr) {
      console.log("[keepalive] notify failed:", (notifyErr as Error).message);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Dispatch by cron schedule
    if (event.cron === "0 12 * * *") {
      ctx.waitUntil(dailySummary(env));
    } else if (event.cron === "0 13 * * *") {
      // 7am Colombia (Sundays-Saturdays): send appointment reminders for tomorrow
      ctx.waitUntil(reminderCron(env));
    } else if (event.cron === "*/10 12-23 * * *") {
      ctx.waitUntil(newBookingsCheck(env));
    } else if (event.cron === "*/15 12-23 * * *") {
      // Cada 15 min: devolver a IA contactos en manual con 30+ min sin actividad
      ctx.waitUntil(autoReturnToAI(env));
    } else if (event.cron === "0 12 * * 1") {
      // Lunes 7am Bogotá: reporte semanal
      ctx.waitUntil(weeklyReport(env));
    } else if (event.cron === "0 14 * * *") {
      // 9am Bogotá diario: follow-up cotizaciones de hace 48h
      ctx.waitUntil(quoteFollowup(env));
    } else {
      // Default: keepAlive (cada 3 min)
      ctx.waitUntil(keepAlive(env));
    }
  },
};
