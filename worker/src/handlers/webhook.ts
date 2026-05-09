import type { Context } from "hono";
import type { Env } from "../env";
import { handleUpdate } from "../telegram";

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

export async function handleTelegramWebhook(c: Context<{ Bindings: Env }>) {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const update = await c.req.json<unknown>();
  c.executionCtx.waitUntil(
    handleUpdate(c.env, update).catch((err) => {
      console.error("update_error", err);
    }),
  );
  return c.json({ ok: true });
}

/**
 * Manually call once after deploy:
 *   GET /tg/setup?token=<CAPTURE_TOKEN>
 */
export async function setupWebhook(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const url = new URL(c.req.url);
  const webhookUrl = `${url.origin}/tg/webhook`;

  const res = await fetch(`${TG_API(c.env.TELEGRAM_BOT_TOKEN)}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: c.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const json = await res.json();
  return c.json({ webhookUrl, telegram: json });
}
