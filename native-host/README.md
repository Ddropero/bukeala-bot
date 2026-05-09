# Bukeala Native Host

Servicio local que mantiene viva la sesión Bukeala 24/7. Se instala una vez en el PC del consultorio.

---

## 🚀 Instalación rápida (10 min)

### Requisito previo

**Node.js LTS** instalado. Si no lo tienes:
1. Ve a https://nodejs.org/
2. Descarga la versión **LTS** (botón verde)
3. Instala con todos los defaults

### Pasos de instalación

1. **Copia esta carpeta** completa al PC del consultorio
   - Recomendado: `C:\BukealaBot\`
   - **NO en OneDrive ni Documents** (puede causar problemas con sync)

2. Abre **PowerShell** en esa carpeta:
   - Click derecho en la carpeta → "Abrir en Terminal" o "PowerShell aquí"

3. Corre el instalador:
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

4. El script te pedirá:
   - **Capture token** → te lo pasa el doctor
   - El **Worker URL** ya viene pre-configurado (puedes dejar el default)

5. Cuando lo pida, **se abre una ventana de Chromium**:
   - Loguea con tu usuario CAS Colsanitas
   - Resuelve el reCAPTCHA
   - Espera a ver "Buscar disponibilidad"
   - La ventana **se cierra sola** en 3 seg

6. ¡Listo! El instalador crea 2 tareas programadas y arranca todo automáticamente.

---

## 🔄 Día a día

### Cuando todo va bien
- **No tienes que hacer NADA**
- Cada 4 horas el bot refresca cookies solo
- El bot Telegram funciona normalmente

### Cuando llega un aviso "Sesión Bukeala expiró"
**Opción A** (preferida — desde el celular):
1. En Telegram manda `/sesion_renew`
2. Camina al PC del consultorio (tienes 30 seg)
3. Se abre Chromium con el login
4. Loguea, ventana se cierra sola
5. Te llega "✅ Sesión renovada" en Telegram

**Opción B** (estás en el PC):
1. Abre PowerShell en la carpeta del bot
2. `node index.js --setup`
3. Loguea en la ventana que se abre

---

## 🛠️ Comandos útiles

```powershell
# Ver tareas programadas
Get-ScheduledTask -TaskName "Bukeala*"

# Forzar un refresh ahora
Start-ScheduledTask -TaskName "BukealaBotSessionRefresh"

# Ver últimos logs
Get-Content $env:APPDATA\BukealaBot\last-run.log -Tail 20

# Ver estado del watcher
Get-Content $env:APPDATA\BukealaBot\watcher.log -Tail 20

# Re-login manual
node index.js --setup

# Desinstalar todo
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

---

## 📂 Qué se instala dónde

| Ubicación | Qué |
|---|---|
| `C:\BukealaBot\` (donde extraigas) | Código + node_modules + Playwright Chromium (~150 MB) |
| `%APPDATA%\BukealaBot\` | Configuración + cookies + logs (privado del usuario) |
| Task Scheduler | 2 tareas: `BukealaBotSessionRefresh` y `BukealaBotRefreshWatcher` |

### Archivos en `%APPDATA%\BukealaBot\`
- `config.json` — Worker URL + capture token
- `state.json` — Cookies de sesión Bukeala
- `last-run.log` — Logs del refresh task
- `watcher.log` — Logs del watcher
- `last-error.png` — Screenshot del último error (si hay)

---

## ❓ Troubleshooting

### "El comando node no se reconoce"
- Node.js no está instalado o no está en el PATH
- Solución: instala Node LTS y reinicia PowerShell

### "Login fallo (still at CAS)"
- Las credenciales están mal o la sesión CAS está bloqueada
- Solución: corre `node index.js --setup` y verifica las credenciales
- También puedes ver `%APPDATA%\BukealaBot\last-error.png` para ver qué pasó

### "TGC expired" inmediatamente después del setup
- Otro dispositivo se logueó al CAS y tumbó la sesión
- Solución: NO loguear Bukeala en el navegador normal del PC ni en celular
- El Native Host es la única sesión activa

### El Telegram dice "sesión expirada" pero no llegan notificaciones de /sesion_renew
- El watcher no está corriendo
- Verifica: `Get-ScheduledTaskInfo -TaskName "BukealaBotRefreshWatcher"`
- Si está parado: `Start-ScheduledTask -TaskName "BukealaBotRefreshWatcher"`

### Las tareas no corren cuando el PC está dormido
- Eso es normal — Windows pausa Scheduled Tasks cuando duerme
- Cuando despierta, el watcher arranca solo (StartWhenAvailable=true)
- Para evitar: configurar el PC para no dormir, o conectarlo a corriente

---

## 🔒 Seguridad

- **Capture token**: identificación que el worker usa para confiar en este PC. Nunca lo compartas por WhatsApp/email.
- **Cookies de Bukeala**: viven en `%APPDATA%\BukealaBot\state.json`. Si alguien copia este archivo a otro PC, podrían usar tu sesión hasta que expire (~24h). Mantén el PC con clave de Windows.
- **No instales en OneDrive**: los archivos pueden quedar como "online-only" y romper el funcionamiento.

---

## ☎️ Si algo no funciona

1. Revisa los logs con los comandos de arriba
2. Avisa al doctor con:
   - Qué comando estabas corriendo
   - Qué error salió
   - El contenido del último log
