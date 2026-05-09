# Bukeala Telegram Bot — Build Package

Bot de Telegram para agendar citas en la plataforma Bukeala (Colsanitas / `appoint.tuscitasmedicas.com`).
Login manual desde tu PC con una extensión de Chrome/Edge que captura la cookie. Uso 100% desde Telegram en iPhone.

## Arquitectura

```
[Tú en PC]                                           [Tú en iPhone]
    │                                                      │
    │ 1. login manual en Bukeala                           │ 4. /buscar, /citas, /cancelar
    │ 2. extensión envía cookies                           │
    ▼                                                      ▼
┌─────────────────────────┐   ┌──────────────────────────┐
│  Cloudflare Worker      │◄──┤  Telegram Bot API        │
│  (TypeScript + Hono)    │   │  webhook                 │
│                         │   └──────────────────────────┘
│  - /capture             │
│  - /tg/webhook          │
│  - /debug/*             │
│  - cliente Bukeala HTTP │
└────────┬────────────────┘
         │ 3. requests autenticados con cookie
         ▼
   appoint.tuscitasmedicas.com
   /keraltyadscritos/...
```

## Componentes

| Carpeta            | Qué es                                                      |
|--------------------|-------------------------------------------------------------|
| `worker/`          | Cloudflare Worker en TypeScript con Hono y grammY.          |
| `extension/`       | Extensión Manifest V3 para Chrome/Edge que captura cookies. |
| `PROJECT_BRIEF.md` | Contexto completo, decisiones, restricciones.               |
| `BUKEALA_API.md`   | Referencia de los endpoints internos de Bukeala.            |
| `DEPLOY.md`        | Guía paso a paso de despliegue.                             |
| `CLAUDE_CODE_PROMPT.md` | Prompt para pegar en Claude Code y completar el código. |

## Por dónde empezar

1. Lee **PROJECT_BRIEF.md** para el contexto.
2. Lee **BUKEALA_API.md** para los endpoints.
3. Sigue **DEPLOY.md** para desplegar.
4. Si quieres que Claude Code complete los `TODO:` en el código, abre **CLAUDE_CODE_PROMPT.md** y pega ese prompt en Claude Code dentro de la carpeta `bukeala-bot/`.

## Estado actual

- ✅ Endpoints de Bukeala mapeados.
- ✅ Worker scaffold con cliente HTTP completo.
- ✅ Extensión Chrome lista para capturar cookies (incluye HttpOnly).
- ✅ Telegram webhook handler con `/start`, `/sesion`, `/buscar`, `/citas`.
- ⚠️ Parseo de respuestas y flujo conversacional con botones inline: **TODO** (ver `worker/src/telegram.ts`). Se completa en vivo después de hacer la primera captura y llamar `/debug/components`.
