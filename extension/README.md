# Bukeala Session Sender (extensión Chrome/Edge)

Captura todas las cookies de los dominios `tuscitasmedicas.com` y `colsanitas.com` (incluyendo las HttpOnly) y las envía al Worker.

## Instalación (modo desarrollador)

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa "Modo de desarrollador" en la esquina superior.
3. Clic en "Cargar descomprimida" y selecciona la carpeta `extension/`.
4. La extensión aparece en la barra. Fíjala (alfiler).

> Nota: falta el archivo `icon.png`. Pon cualquier PNG cuadrado de 128px en `extension/icon.png` o elimina la sección `icons` del `manifest.json`.

## Uso

1. En una pestaña, abre Bukeala y logueate como siempre (con reCAPTCHA y todo).
2. Clic en el ícono de la extensión.
3. Pega la **Worker URL** (ej. `https://bukeala-bot.<subdomain>.workers.dev/capture`) y el **CAPTURE_TOKEN**.
4. Clic en "Enviar sesión". Verás `✅ OK. N cookies. Expira: ...`.
5. Listo. Tu bot puede usar la sesión hasta que expire (~12 h).

Si el Worker responde 401, revisa que el token coincida con el secreto `CAPTURE_TOKEN` que pusiste con `wrangler secret put`.
