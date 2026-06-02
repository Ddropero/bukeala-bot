# Imagen oficial de Playwright: trae Chromium + todas las libs del SO ya
# instaladas (fuente #1 de dolores de cabeza si uno usa node:slim pelado).
# La versión del tag debe ser compatible con playwright-core resuelto por npm.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Instala deps primero (capa cacheable). package-lock si existe.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copia el código
COPY autoLogin.js watcher.js ./

# El navegador ya viene en la imagen; le decimos a playwright dónde está.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

# Sin puerto: es un worker de fondo, no un servidor HTTP.
CMD ["node", "watcher.js"]
