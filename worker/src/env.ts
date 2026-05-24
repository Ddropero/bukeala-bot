export type Env = {
  // KV namespaces
  SESSIONS: KVNamespace;
  STATE: KVNamespace;

  // Durable Object pinned to enam (us-east) for proxying Bukeala fetches.
  BUKEALA_PROXY: DurableObjectNamespace;

  // vars (wrangler.toml)
  BUKEALA_BASE: string; // https://appoint.tuscitasmedicas.com/keraltyadscritos
  BRANCH_ID: string;    // 456

  // secrets (wrangler secret put ...)
  CAPTURE_TOKEN: string;       // shared with the extension and debug endpoints
  ENCRYPTION_KEY: string;      // 64 hex chars (32 bytes), AES-256-GCM
  TELEGRAM_BOT_TOKEN: string;  // from @BotFather
  ALLOWED_CHAT_ID: string;     // your numeric chat id
  WEBHOOK_SECRET: string;      // random, set as Telegram webhook secret_token

  // WhatsApp Cloud API (Meta) — patient appointment reminders
  WA_TOKEN: string;            // EAA... access token
  WA_PHONE_ID: string;         // numeric phone number ID
  WA_VERIFY_TOKEN: string;     // arbitrary string we set in Meta App webhook config

  // Anthropic API for the WhatsApp AI auto-responder (Claude)
  ANTHROPIC_API_KEY: string;

  // Secretary's WhatsApp numbers (comma-separated, E.164 without `+`).
  // Receives the daily agenda PDF/HTML at 1 PM Colombia the day before.
  // Optional — if unset, falls back to the hard-coded default.
  SECRETARY_WHATSAPP_NUMBERS?: string;
};
