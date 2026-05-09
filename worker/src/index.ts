import { Hono } from "hono";
import type { Env } from "./env";
import { handleCapture } from "./handlers/capture";
import { handleTelegramWebhook, setupWebhook } from "./handlers/webhook";
import { handleDebug } from "./handlers/debug";
import { verifyWhatsAppWebhook, handleWhatsAppWebhook } from "./handlers/whatsappWebhook";
import { handleNativeHostEvent, handleCheckRefresh, handleRefreshComplete } from "./handlers/nativeHostEvent";
import { Bukeala, SessionExpiredError } from "./bukeala";
import { loadSession } from "./kv";
import { dailySummary } from "./cron/dailySummary";
import { newBookingsCheck } from "./cron/newBookingsWatch";
import { getDoctorRecipients } from "./users";

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

// WhatsApp Cloud API webhook (Meta → Worker)
//   GET  → verification handshake (hub.verify_token must match WA_VERIFY_TOKEN)
//   POST → incoming messages + delivery statuses
app.get("/wa/webhook", verifyWhatsAppWebhook);
app.post("/wa/webhook", handleWhatsAppWebhook);

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
  const b = new Bukeala(env);
  try {
    const res = await b.findCustomerPage();
    await res.text();
    console.log(`[keepalive] OK status=${res.status}`);
    // Reset the "notified" flag so a future expiry triggers a fresh notice
    await env.STATE.delete("keepalive:notified");
  } catch (e) {
    if (!(e instanceof SessionExpiredError)) {
      console.log("[keepalive] unexpected error:", (e as Error).message);
      return;
    }
    console.log("[keepalive] session expired — notifying user");
    const alreadyNotified = await env.STATE.get("keepalive:notified");
    if (alreadyNotified) {
      console.log("[keepalive] notice already sent for this expiry, skip");
      return;
    }
    try {
      // Send only to doctors — secretaries don't need tech alerts
      const doctors = await getDoctorRecipients(env);
      for (const doctorChatId of doctors) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: doctorChatId,
            text:
              "⚠️ <b>Sesión Bukeala expirada</b>\n\n" +
              "Corre <code>node index.js --setup</code> en el Native Host para refrescar la sesión.",
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
    } else if (event.cron === "*/10 12-23 * * *") {
      ctx.waitUntil(newBookingsCheck(env));
    } else {
      // Default: keepAlive (every 5 min)
      ctx.waitUntil(keepAlive(env));
    }
  },
};
