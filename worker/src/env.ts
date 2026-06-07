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

  // Cloudflare Workers AI (binding configurado en wrangler.toml)
  // Usado para transcribir voice notes con Whisper.
  AI: Ai;

  // ============================================================
  // POP CUC — Agenda Cirugías Clínica Colombia (Google Calendar)
  // ============================================================
  // Si están configuradas, el bot crea eventos en Google Calendar
  // cuando alguien (cualquier WA o Telegram) escribe "pop cuc".
  //
  // Setup:
  //   1) En Google Cloud Console: crear proyecto + habilitar "Google Calendar API"
  //   2) Crear Service Account, descargar JSON de credenciales
  //   3) En Google Calendar: crear calendario "Cirugías Clínica Colombia"
  //   4) Compartirlo con el client_email del service account ("Hacer cambios en eventos")
  //   5) Copiar el Calendar ID (Configuración → Integrar calendario)
  //   6) wrangler secret put GCAL_SERVICE_ACCOUNT_JSON  (pegar JSON completo)
  //   7) wrangler secret put GCAL_CALENDAR_ID          (pegar el ID, ej: abc123@group.calendar.google.com)
  //
  // Si NO están configuradas, pop cuc cae a modo legacy (solo KV).
  GCAL_SERVICE_ACCOUNT_JSON?: string;
  GCAL_CALENDAR_ID?: string;

  // OPCIONAL: bot dedicado para handoff humano (cuando AI escala).
  // Si no está seteado, los escalations siguen llegando al bot principal.
  // Setup: 1) crea bot en @BotFather  2) wrangler secret put TELEGRAM_HANDOFF_BOT_TOKEN
  //        3) curl https://<worker>/tg/handoff-setup?token=<CAPTURE_TOKEN>
  TELEGRAM_HANDOFF_BOT_TOKEN?: string;

  // OPCIONAL: grupo de Telegram con "Temas" (forum) activados, donde cada
  // paciente escalado tiene su propio HILO. Si está seteado, el handoff usa
  // Forum Topics (un chat por paciente) en vez de DMs sueltos. El bot de
  // handoff debe ser ADMIN del grupo con permiso "Administrar temas".
  // Setup: 1) crea grupo, actívale Temas  2) agrega el handoff bot como admin
  //        3) wrangler secret put TELEGRAM_HANDOFF_GROUP_ID (ej. -1001234567890)
  TELEGRAM_HANDOFF_GROUP_ID?: string;

  // OPCIONAL: bot dedicado a Andrea (encargada de cotizaciones).
  // Si no está seteado, las solicitudes de cotización van al bot principal.
  // Setup: 1) crea bot en @BotFather  2) wrangler secret put TELEGRAM_QUOTES_BOT_TOKEN
  //        3) curl https://<worker>/tg/quotes-setup?token=<CAPTURE_TOKEN>
  TELEGRAM_QUOTES_BOT_TOKEN?: string;

  // OPCIONAL: Instagram Messaging API (Meta Graph).
  // Permite que la AI atienda DMs de Instagram igual que WhatsApp.
  // Setup:
  //   1) Cuenta IG convertida a Business/Profesional
  //   2) Conectada a Página de Facebook
  //   3) Meta App con permisos instagram_basic + instagram_manage_messages
  //   4) Generar System User token con scope a la página
  //   5) wrangler secret put IG_ACCESS_TOKEN
  //   6) wrangler secret put IG_BUSINESS_ACCOUNT_ID (ID numérico de tu cuenta IG)
  //   7) wrangler secret put IG_VERIFY_TOKEN (cualquier string random)
  //   8) Configurar webhook URL en Meta App: https://<worker>/ig/webhook
  IG_ACCESS_TOKEN?: string;
  IG_BUSINESS_ACCOUNT_ID?: string;
  IG_VERIFY_TOKEN?: string;

  // Secretary's WhatsApp numbers (comma-separated, E.164 without `+`).
  // Receives the daily agenda PDF/HTML at 1 PM Colombia the day before.
  // Optional — if unset, falls back to the hard-coded default.
  SECRETARY_WHATSAPP_NUMBERS?: string;
};
