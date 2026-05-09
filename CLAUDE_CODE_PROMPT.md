# Prompt para Claude Code

> Pega esto como primer mensaje en Claude Code, dentro de la carpeta `bukeala-bot/`.

---

Estoy construyendo un bot de Telegram que agenda citas en la plataforma Bukeala (Colsanitas). El proyecto ya está scaffolded en este directorio. Tu trabajo:

1. Lee, en este orden, para entender el contexto: `README.md`, `PROJECT_BRIEF.md`, `BUKEALA_API.md`, `DEPLOY.md`.
2. Lee el código en `worker/src/`. Está completo en lo estructural pero tiene TODOs marcados — son donde necesito tu trabajo.
3. Ayúdame a desplegar siguiendo `DEPLOY.md`. Hazme las preguntas que necesites (nombre del Worker, etc.) y ejecuta los comandos uno a uno conmigo.
4. Una vez desplegado y con la sesión capturada vía la extensión, llamemos los endpoints `/debug/components`, `/debug/search`, `/debug/myBookings`, `/debug/customer` y con la respuesta REAL de cada uno, completa los `TODO:` de `worker/src/telegram.ts`. Específicamente:
   - `startBookingFlow` → ajustar parseo de `loadComponents` a la shape real.
   - `parseSlots` → idem para `doSearch`.
   - `onCustomerIdEntered` → idem para `findCustomer/validate`.
   - `showMyBookings` → parsear `myBookings` (puede ser HTML; usar regex o `htmlparser2`).
   - `onCancelBooking` → flujo de cancelación con motivos reales (`cancelationReasons`).
5. Antes de cada cambio, dime qué vas a hacer. No "mejores" la arquitectura sin discutir conmigo. Mantén el código tan simple como ya está.
6. Verifica todo con `npm run typecheck` antes de cada commit.

Reglas:
- Worker en TypeScript, runtime de Cloudflare Workers (no Node APIs salvo `nodejs_compat`).
- Usa `fetch` directo a Telegram Bot API (no instales `grammy` ni librerías nuevas sin pedir permiso).
- KV para persistencia (sesión cifrada + estado de conversación). Nada de D1 o R2.
- Cifrado AES-256-GCM con WebCrypto, ya implementado en `crypto.ts`.
- No loguees cookies, ni cédulas, ni nombres de pacientes.
- El bot solo responde a `ALLOWED_CHAT_ID`.

Si encuentras un endpoint que no esperabas o el shape de una respuesta no coincide con `BUKEALA_API.md`, actualiza `BUKEALA_API.md` con la nueva info y avísame.

Empieza leyendo los docs y luego confirma el plan conmigo antes de tocar código.
