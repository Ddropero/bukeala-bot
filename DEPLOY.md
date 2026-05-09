# Deploy guide

## Prerrequisitos

- Cuenta de Cloudflare gratis (`cloudflare.com/sign-up`).
- Node.js 20+ instalado.
- Bot de Telegram creado en `@BotFather` → guarda el `TELEGRAM_BOT_TOKEN`.
- Tu chat id Telegram (de `@userinfobot`) → `ALLOWED_CHAT_ID`.

## 1. Generar secretos

En tu terminal:

```bash
# Capture token (cualquier string aleatorio largo)
openssl rand -hex 24
# → ej. 4a1b...   guarda como CAPTURE_TOKEN

# Encryption key (32 bytes = 64 hex chars)
openssl rand -hex 32
# → ej. 9f3c...   guarda como ENCRYPTION_KEY

# Webhook secret (cualquier string aleatorio)
openssl rand -hex 24
# → guarda como WEBHOOK_SECRET
```

> En Windows sin OpenSSL: usa Node:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

## 2. Worker

```bash
cd worker
npm install
npx wrangler login

# Crear KVs (anota los IDs y pégalos en wrangler.toml)
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create STATE

# Editar wrangler.toml: reemplaza los REPLACE_WITH_..._KV_ID con los IDs reales

# Configurar secrets (te los pide interactivamente)
npx wrangler secret put CAPTURE_TOKEN
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALLOWED_CHAT_ID
npx wrangler secret put WEBHOOK_SECRET

# Deploy
npx wrangler deploy
```

Anota la URL final, ej: `https://bukeala-bot.tu-subdomain.workers.dev`.

## 3. Configurar webhook de Telegram

```bash
curl "https://bukeala-bot.tu-subdomain.workers.dev/tg/setup?token=<CAPTURE_TOKEN>"
```

Debe responder `{ ok: true, ... }`.

## 4. Instalar la extensión

Sigue `extension/README.md`. Pega:
- Worker URL: `https://bukeala-bot.tu-subdomain.workers.dev/capture`
- Capture token: tu `CAPTURE_TOKEN`

## 5. Primera prueba

1. Abre Bukeala en tu PC, logueate normalmente.
2. Clic en la extensión → "Enviar sesión". Verás OK.
3. Abre Telegram, manda `/start` al bot. Debe responder.
4. Manda `/sesion` → debe decir "🟢 Sesión activa".

## 6. Calibrar parseo (5 minutos)

Como el HAR no incluyó respuestas, hay que ver la forma real:

```bash
# Especialidades
curl "https://bukeala-bot.tu-subdomain.workers.dev/debug/components?token=<CAPTURE_TOKEN>"

# Slots disponibles para una especialidad (saca el code del paso anterior)
curl "https://bukeala-bot.tu-subdomain.workers.dev/debug/search?token=<CAPTURE_TOKEN>&componentCode=890239&date=06/05/2026"

# Mis citas
curl "https://bukeala-bot.tu-subdomain.workers.dev/debug/myBookings?token=<CAPTURE_TOKEN>"

# Buscar paciente
curl "https://bukeala-bot.tu-subdomain.workers.dev/debug/customer?token=<CAPTURE_TOKEN>&type=1&id=1234567890"
```

Pega esas respuestas a Claude Code y pídele que termine los `TODO:` en `worker/src/telegram.ts` (función `parseSlots` y la del `findCustomer` y `myBookings`).

## 7. Debug

```bash
# Logs en vivo
cd worker
npx wrangler tail
```
