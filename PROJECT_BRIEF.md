# Project Brief — Bukeala Telegram Bot

## Objetivo

Permitir que un médico (un solo usuario) agende pacientes en Bukeala (Colsanitas / Keralty) desde su iPhone, vía un bot de Telegram. La autenticación se hace manualmente desde el PC del usuario y la sesión se reusa hasta que expira.

## Restricciones

- **reCAPTCHA y Cloudflare** en el login → no se automatiza el login. El usuario se autentica como siempre en su navegador.
- **Cookies HttpOnly** → se capturan vía API `chrome.cookies` desde una extensión, no con bookmarklet.
- **iPhone** del usuario → no app nativa, todo por Telegram.
- **15 pacientes/semana** → bajo volumen, optimizar simplicidad sobre rendimiento.
- **Datos sensibles (PII de pacientes)** → cifrado en reposo (AES-GCM), TTL en KV, sin logs con PII.
- **Solo un usuario** → bot bloquea cualquier `chat_id` que no sea `ALLOWED_CHAT_ID`. La secretaria sigue usando la web directamente.

## Stack

- **Cloudflare Workers** (free tier suficiente).
- **TypeScript + Hono** (router minimalista, ideal para Workers).
- **Cloudflare KV** para sesión cifrada y estado de conversación.
- **Telegram Bot API** vía webhook (sin librerías pesadas; fetch directo).
- **Manifest V3 extension** para Chrome / Edge / Brave en el PC del usuario.

## Flujo de uso

1. **Login (PC, 1–2 veces al día)**
   - Usuario abre `app01.colsanitas.com/cas/login?service=https://appoint.tuscitasmedicas.com/keraltyadscritos/cas/login`
   - Ingresa usuario, password, resuelve reCAPTCHA, queda dentro.
   - Hace clic en el ícono de la extensión "Bukeala Session Sender".
   - La extensión lee `chrome.cookies.getAll({domain: 'tuscitasmedicas.com'})` y POSTea al Worker.
   - Worker cifra la cookie con AES-GCM y la guarda en KV con TTL.

2. **Agendamiento (iPhone, todo el día)**
   - `/start` → menú principal.
   - `/buscar` → bot llama `loadComponents` → muestra inline keyboard con especialidades.
   - Tap en especialidad → `loadAreaHints` (si aplica) + `doSearch` para próximos 15 días.
   - Bot muestra slots disponibles agrupados por día.
   - Tap en slot → bot pide cédula del paciente.
   - Usuario escribe cédula → `findCustomer/validate` → bot muestra nombre y pide confirmación.
   - Tap "Confirmar" → `validateBookingDate` → `addPrebookingSchedule` → `postBooking` → cita creada.
   - `/citas` lista citas activas.
   - `/cancelar` lista citas y permite cancelar con motivo.

3. **Si la sesión expiró**
   - El Worker detecta 401/302 al hacer fetch a Bukeala.
   - Bot manda mensaje a Telegram: "Sesión expirada, captura una nueva con la extensión."

## Decisiones clave

| Decisión                              | Razón                                                     |
|---------------------------------------|-----------------------------------------------------------|
| Extensión vs bookmarklet              | Las cookies de sesión Java suelen ser HttpOnly.          |
| Worker en TS vs Python                | TS es nativo en Cloudflare Workers, mejor tooling.       |
| Hono vs framework propio              | 30 líneas para tener routing limpio y middleware.        |
| KV vs D1                              | KV es más simple para 1 sesión + estado de conversación. |
| Cookie cifrada en KV                  | Si la KV se filtra, sin la key no sirve.                 |
| Webhook en lugar de polling           | Cero costo idle; instantáneo.                            |
| `chat_id` allowlist                   | Bot solo responde al dueño.                              |

## Lo que falta completar (TODOs)

Después de hacer la primera captura de cookie y llamar `/debug/components` y `/debug/search?...`, hay que:

1. Parsear `loadComponents` → array de `{id, code, name}` para construir keyboards.
2. Parsear `doSearch` → array de slots con `bookingComponentId`, `areaId`, `bookingDateStr`, `bookingTime`, `professional`, `branchCode`, `secondExternalCode`, `duration`.
3. Implementar máquina de estados de conversación en KV `STATE:{chat_id}` con campos: `step`, `selectedComponent`, `selectedSlot`, `customerData`.
4. Construir el payload final de `postBooking` a partir del slot seleccionado y los datos del cliente. Estructura exacta en `BUKEALA_API.md`.
5. Parsear `myBookings` (HTML) para listar citas del usuario y permitir cancelarlas.

## No-goals

- No automatizar login (reCAPTCHA).
- No reemplazar a la secretaria (ella sigue usando la web).
- No multiusuario (un solo médico, un solo `chat_id`).
- No pagos ni MercadoPago.
- No búsqueda multi-componente ni reasignaciones (fase 2).
