# Sesión Bukeala con navegador persistente

Este directorio incluye un modo que conserva el perfil completo de Chromium en
disco y reutiliza el mismo contexto entre renovaciones. Su objetivo es mantener
la sesión desde una máquina en la nube, incluso cuando el computador del usuario
está apagado.

La implementación y las pruebas locales no acreditan por sí solas que el login
funcione desde la nube, que el proveedor acepte una recuperación desatendida ni
que exista continuidad de 24 horas. Este documento describe el código; no
certifica un despliegue ni una prueba real.

## Componentes y comportamiento

- [watcher.js](./watcher.js) selecciona el modo. Solo utiliza el nuevo flujo si
  `BROWSER_SESSION_MODE=persistent`; cualquier otro valor mantiene el flujo
  anterior.
- [persistentSession.js](./persistentSession.js) abre un perfil persistente,
  comprueba autenticación, conserva el navegador ante errores transitorios y
  controla los intentos de login completo.
- [persistentWatcher.js](./persistentWatcher.js) ejecuta los ciclos, atiende
  órdenes remotas y guarda el estado del servicio y sus tiempos de reintento.
- [persistentProbe.js](./persistentProbe.js) prueba el navegador sin publicar
  cookies ni enviar eventos o confirmaciones al Worker.
- [autoLogin.js](./autoLogin.js) contiene los auxiliares compartidos de
  autenticación, validación y publicación. Conserva también funciones del modo
  anterior.

En modo persistente, una renovación comienza usando el perfil existente. Una
respuesta que indica falta de autenticación puede iniciar el flujo CAS dentro
del mismo contexto. Un error de red, un error del servidor o una respuesta JSON
inesperada no deben convertirse en un nuevo intento de credenciales.

La validación estricta requiere una respuesta reconocible de `loadComponents`:
un array no vacío de objetos con `id` numérico, `code` no vacío y `description`
de tipo string. Una página HTML con HTTP 200, un JSON arbitrario o la mera
existencia de una cookie no bastan. Una lista vacía tampoco acredita
autenticación: la muestra disponible no permite distinguirla de una respuesta
inválida y el validador la rechaza.

En el servicio normal, un ciclo solo informa éxito cuando coinciden
`authenticated`, `published` y `workerVerified`. Primero valida el navegador,
publica mediante `/capture` y luego comprueba que el Worker obtiene componentes
válidos mediante `/debug/components`. La publicación puede activar las colas
pendientes del Worker; `npm start` es una operación real.

El modo persistente no aplica el reciclaje periódico por edad o número de usos
del modo anterior. Tampoco importa automáticamente cookies antiguas ni borra el
perfil como mecanismo de recuperación.

## Recuperación automática y Telegram

El Worker comprueba el JSON autenticado de Bukeala cada tres minutos. Si falta
acceso, crea una solicitud que consume la VM. Las solicitudes automáticas se
agrupan con cualquier recuperación pendiente; no reemplazan a sus destinatarios
ni reinician la espera. `/sesion_renew` sigue disponible para solicitar una
comprobación, pero no es necesario repetirlo para que haya reintentos.

Cada solicitud conserva `requestedAt` como identificador. El watcher lo devuelve
en `/native-host/refresh-complete`, junto con `ok`, `completedAt`, el código de
fallo si corresponde y `nextAttemptAt`. Un resultado viejo no debe cerrar otra
solicitud. Los resultados fallidos conservan la solicitud y su próxima espera.
La retención en KV es de siete días y se renueva con cada intento.

El watcher persiste `pendingRequest` y `completionOutbox` en su estado local.
Una recuperación posterior, incluso después de reiniciar el servicio, completa
la misma solicitud. Si el callback falla, vuelve a entregarlo sin repetir un
login solo para enviar la confirmación. Una comprobación más reciente que falla
reemplaza cualquier éxito anterior que todavía no se hubiera entregado.

Los incidentes automáticos rápidos se resuelven sin avisos. Si la caída dura al
menos seis minutos, el siguiente control informa que la recuperación sigue en
curso. Un desafío de autenticación puede avisarse antes. Tras un aviso, la
recuperación confirmada envía su cierre a los doctores; las solicitudes manuales
se confirman a sus propios chats. Las etiquetas internas `auto-*` nunca son
destinatarios de Telegram. Las confirmaciones parcialmente entregadas solo se
reintentan para los destinatarios pendientes.

KV no ofrece compare-and-swap: la correlación y la relectura reducen carreras,
pero no equivalen a una exclusión distribuida entre regiones. El despliegue
actual utiliza un único renovador activo en la VM.

Pruebas sin servicios externos:

```bash
# Desde native-host-cloud
npm test
# Desde worker
node --test test/sessionRecovery.test.mjs test/sessionRecoveryHandlers.test.mjs
npm run typecheck
```

## Variables

| Variable | Uso y valor predeterminado |
| --- | --- |
| `BROWSER_SESSION_MODE` | Debe ser `persistent` para usar este modo mediante `npm start` o `node watcher.js`. Docker y el startup de GCE lo configuran explícitamente. |
| `BROWSER_PROFILE_DIR` | Directorio duradero del perfil. El gestor usa `~/.bukeala-browser` si falta; el comando `probe` exige un valor explícito. GCE configura `/var/lib/bukeala/browser-profile`; Fly, `/data/browser-profile`. |
| `BROWSER_HEADLESS` | `0` abre Chromium con ventana sobre `DISPLAY`; cualquier otro valor usa modo sin interfaz. GCE usa `0` con una pantalla Xvfb privada porque la prueba desde esa VM rechazó el headless shell. |
| `WORKER_URL` | URL HTTPS del endpoint de captura, terminada en `/capture`. Obligatoria para el watcher y para una migración `--seed-worker`; el probe ordinario no la necesita. |
| `CAPTURE_TOKEN` | Secreto de captura. Obligatorio para el watcher y `--seed-worker`; no se necesita para un probe ordinario sin publicación. |
| `ENABLE_FULL_LOGIN` | Solo el valor `1` permite intentar login completo. El valor seguro inicial de GCE y Fly es `0`. |
| `CAS_USERNAME`, `CAS_PASSWORD` | Credenciales exigidas únicamente cuando se habilita y se necesita login completo en el modo persistente. |
| `TWO_CAPTCHA_API_KEY` | Configuración del auxiliar de login heredado. Su presencia no acredita que el proveedor permita o acepte la autenticación desde la nube. |
| `FULL_LOGIN_COOLDOWN_MS` | Pausa tras un intento fallido de login completo. Mínimo efectivo: `1800000` ms, 30 minutos; también es el valor predeterminado. |
| `PROACTIVE_INTERVAL_MS` | Intervalo normal entre renovaciones exitosas: `600000` ms, 10 minutos. Valores inferiores a 60 segundos o inválidos vuelven al predeterminado. |
| `POLL_INTERVAL_MS` | Sondeo del watcher: `30000` ms, 30 segundos. Valores inferiores a 1 segundo o inválidos vuelven al predeterminado. El sondeo respeta el backoff. |
| `PLAYWRIGHT_BROWSERS_PATH` | Debe coincidir con la instalación de Chromium. GCE usa `/root/.cache/ms-playwright`; la imagen Docker usa `/ms-playwright`. |

`DISABLE_AUTO_LOGIN` pertenece al modo anterior. No habilita ni deshabilita el
login del modo persistente; para este se utiliza `ENABLE_FULL_LOGIN`.

Las credenciales se inyectan mediante la configuración protegida del entorno.
No deben añadirse a este README, a comandos que se compartan, a archivos
versionados ni a informes de pruebas.

## Perfil y estado local

El perfil contiene material de autenticación y debe vivir en un disco o volumen
persistente, fuera del checkout. En Linux, el gestor restringe el directorio a
`0700` y sus archivos de estado a `0600`. El servicio GCE añade `UMask=0077`.
En Windows, estos modos POSIX no sustituyen los permisos NTFS: debe limitarse el
acceso al usuario que ejecuta el proceso.

[.gitignore](../.gitignore) excluye `browser-profile/`, `.bukeala-browser/` y
archivos HAR. Una ruta con otro nombre no queda necesariamente cubierta; mantener
todo perfil fuera del repositorio evita depender de esos patrones. No copiar
el perfil, sus cookies ni un HAR a Git.

Solo un proceso debe abrir cada perfil. Para un probe mientras el servicio sigue
activo, usar un directorio separado. Para comprobar exactamente el perfil del
servicio, detener previamente su proceso en una intervención planificada y
esperar el cierre de Chromium; no ejecutar dos instancias contra el mismo
directorio ni borrar archivos de bloqueo.

Dentro del perfil se guardan:

- `session-keeper.json`: validación previa, migración inicial y tiempos de intento
  y éxito del login completo.
- `watcher-status.json`: último resultado, ciclos exitosos, fallos consecutivos y
  próxima fecha de intento. No es una prueba de autenticación actual por sí solo.
- `probe-result.json`: resultado saneado de la última prueba; incluye
  `workerWrites: 0` y las fases ejecutadas.

Los informes del modo persistente omiten cookies, credenciales, cuerpos de
respuesta y valores de query. Conservar el perfil conserva también su política
de reintento. Eliminar sus archivos para forzar intentos anula esa protección.

## Pruebas locales y probe real

Desde la raíz del repositorio:

```bash
cd native-host-cloud
npm install
npm test
```

`npm test` ejecuta las pruebas de
[persistentSession.test.js](./persistentSession.test.js) y
[test/persistentWatcher.test.js](./test/persistentWatcher.test.js). Usan perfiles
temporales, datos sintéticos y dependencias de navegador/red sustituidas.
Cubren persistencia, reinicios, validación, publicación, fallos y backoff. La
simulación de 24 horas acelera el reloj y simula expiraciones: no equivale a
24 horas medidas en Bukeala ni demuestra que un CAPTCHA pueda resolverse desde
la VM.

`npm run probe` abre Chromium y hace peticiones reales a Bukeala. Puede actualizar
la sesión y el perfil local, pero usa `publish: false`: no publica a `/capture`,
no consulta la verificación del Worker y no envía eventos ni mensajes.

Con Chromium instalado y un directorio de prueba protegido y escribible:

```bash
BROWSER_PROFILE_DIR=/ruta/protegida/bukeala-probe npm run probe -- --restart
```

Para reproducir la modalidad de GCE en Linux, instalar `xvfb` y `xauth` y usar
`BROWSER_HEADLESS=0 xvfb-run -a npm run probe -- --restart`, manteniendo
`BROWSER_PROFILE_DIR` y las demás variables en el entorno. Esto crea una pantalla
virtual; no publica un escritorio en Internet.

El probe ordinario impide el login completo, incluso si el entorno tiene
`ENABLE_FULL_LOGIN=1`. En un perfil vacío puede informar
`full-login-disabled`: es un resultado esperado, no una prueba de fallo de
persistencia.

`--restart` cierra Chromium y vuelve a abrir el mismo perfil solo si la fase
inicial obtuvo autenticación. La segunda fase prohíbe login completo, por lo que
comprueba la recuperación del perfil sin una nueva presentación de credenciales.
Es un reinicio del navegador, no un reinicio de VM ni una espera hasta que expire
la sesión.

La opción `--simulate-app-expiry` añade una prueba controlada después de la
validación inicial: elimina únicamente el `JSESSIONID` de Bukeala del perfil
local y llama otra vez al gestor. Conserva las cookies CAS/SSO y no invoca un
logout del servidor. La operación solo está disponible dentro del probe sin
publicación; el servicio normal no la expone. El informe identifica
`local-application-cookie-removal`, para distinguir esta prueba de un
vencimiento real por tiempo o de la expiración de CAS.

`--simulate-sso-expiry --allow-login` amplía la prueba a las cookies locales
de autenticación de CAS (`TGC`/`CASTGC` y su `JSESSIONID`). Conserva el resto del
perfil y los datos de la verificación del proveedor. Debe ejecutarse en una
copia aislada y cerrada del perfil, sin publicar al Worker. El informe identifica
`local-application-and-cas-cookie-removal`; tampoco equivale a esperar una
expiración real del servidor.

Para una prueba de login completo expresamente habilitada, deben coincidir el
interruptor de entorno y la opción del probe, con las credenciales ya inyectadas:

```bash
BROWSER_PROFILE_DIR=/ruta/protegida/bukeala-probe \
  ENABLE_FULL_LOGIN=1 npm run probe -- --allow-login --restart
```

La prueba sigue sin escribir al Worker. Puede presentar credenciales al
proveedor y usar el auxiliar de CAPTCHA configurado; no debe ejecutarse como
sondeo rutinario. Si aparece una verificación interactiva o un bloqueo, el perfil
persistente no elimina esa restricción y el resultado no debe anunciarse como
autenticación válida.

En un probe exitoso son normales `published: false` y `workerVerified: false`.
Para evaluar el resultado, revisar `ok`, `authenticated`, `loginAttempted`,
`reasonCode` y las fases `initial` y `after-browser-restart`. El comando devuelve
un código de salida distinto de cero cuando una fase falla.

## Migración inicial explícita

`renew()` nunca importa una sesión del Worker. La única importación del probe es
la opción `--seed-worker`, que lee `/native-host/session` con el token autorizado
y entrega las cookies al perfil en memoria. No imprime ni guarda una exportación
de ese JSON.

Con `WORKER_URL` y `CAPTURE_TOKEN` ya inyectados:

```bash
BROWSER_PROFILE_DIR=/ruta/protegida/perfil-nuevo \
  npm run probe -- --seed-worker --restart
```

La importación exige un perfil sin cookies relevantes, sin validación previa y
sin una migración anterior. La captura debe tener como máximo 30 minutos, no
estar más de un minuto en el futuro y contener un `JSESSIONID` de Bukeala
admisible. Después se comprueba la autenticación real; copiar cookies no es una
prueba suficiente.

Se rechaza una nueva importación sobre un perfil poblado. No borrar el perfil
para resembrarlo automáticamente. La migración sirve para iniciar una prueba de
continuidad; no prueba que el servicio pueda recuperar una sesión expirada sin
el navegador del usuario.

## Login completo y reintentos

El gestor conserva el momento del intento antes de enviar credenciales. Si el
intento falla, su pausa mínima de 30 minutos sobrevive al reinicio del proceso.
Un resultado válido registra el éxito y permite que una futura expiración tenga
su propio intento.

El watcher añade un backoff persistente:

- Fallos identificados como login, configuración, credenciales o desafío:
  30 minutos inicialmente y hasta 60 minutos con fallos repetidos.
- Otros fallos: 90 segundos inicialmente, aumentando hasta 10 minutos.

El arranque y las órdenes remotas respetan esos plazos. Pedir
`/sesion_renew` repetidamente no debe saltarse el backoff del modo persistente.
Los errores al publicar o verificar el Worker conservan el perfil útil; no
justifican iniciar un login nuevo.

Dejar `ENABLE_FULL_LOGIN=0` permite conservar una sesión válida, pero exige
intervención cuando CAS pide credenciales. Cambiarlo a `1` habilita una ruta
existente: no garantiza que CAS, reCAPTCHA o el control antibot acepten el flujo
cloud. Si el proveedor exige una validación humana, el requisito de recuperación
sin intervención permanece pendiente.

## GCE: empaquetado, metadata y servicio

[build-startup-script.sh](./build-startup-script.sh) genera
[startup-script.sh](./startup-script.sh) autocontenido con el código y
`package.json`. Desde este directorio:

```bash
bash build-startup-script.sh
bash -n startup-script.sh
```

Regenerar el archivo después de cambiar `autoLogin.js`, `watcher.js`, cualquiera
de los tres módulos persistentes, `package.json` o el generador. La imagen de
arranque no descarga automáticamente la última versión del repositorio.

Para que una instalación GCE reciba la actualización hacen falta dos pasos
distintos:

1. Actualizar el atributo de metadata `startup-script` de la instancia con el
   archivo recién generado, usando la instancia, zona y proyecto verificados.
2. Aplicar ese startup actualizado en una intervención planificada. Ejecutarlo
   instala dependencias, escribe la unidad y reinicia `bukeala.service`.
   Guardar metadata por sí solo no reemplaza el proceso que ya corre.

El script obtiene estos atributos de metadata:

| Atributo GCE | Variable resultante |
| --- | --- |
| `worker-url` | `WORKER_URL` |
| `capture-token` | `CAPTURE_TOKEN` |
| `cas-username` | `CAS_USERNAME` |
| `cas-password` | `CAS_PASSWORD` |
| `twocaptcha-key` | `TWO_CAPTCHA_API_KEY` |
| `browser-session-mode` | `BROWSER_SESSION_MODE`, predeterminado `persistent` |
| `enable-full-login` | `ENABLE_FULL_LOGIN`, predeterminado `0` |

Los atributos sensibles existentes se conservan mediante el mecanismo de
configuración autorizado. No incluir sus valores en el script generado ni
copiar una salida de metadata al repositorio. La unidad generada incorpora
credenciales de entorno: no publicar su contenido.

El servicio coloca el código en `/opt/bukeala`, conserva el perfil en
`/var/lib/bukeala/browser-profile`, renueva cada 10 minutos y sondea cada 30
segundos. Usa `Restart=always`, espera 15 segundos tras una salida y permite
hasta 420 segundos de cierre para que el ciclo en curso termine y Chromium
guarde su perfil. Los registros se escriben en `/var/log/bukeala.log` y
`/var/log/bukeala-setup.log`, con rotación configurada.

`bukeala-display.service` mantiene Xvfb en `:99`, con autenticación local en
`/var/lib/bukeala/Xauthority` y sin escucha TCP. El servicio de navegador depende
de esa pantalla, establece `BROWSER_HEADLESS=0` y utiliza `KillMode=mixed` para
que Node pueda cerrar Chromium y guardar el perfil antes de terminar.

La versión de Playwright está fijada a `1.59.1`, la utilizada en las pruebas de
la VM. Un arranque no debe actualizar Chromium implícitamente y cambiar las
características del navegador que ya fue autenticado.

Un reinicio del servicio debe conservar el directorio del perfil. Comprobar el
estado del servicio y `watcher-status.json` permite confirmar qué proceso corre;
la aceptación operativa requiere además resultados reales de autenticación y
verificación del Worker. No basta con que systemd indique `active`.

## Docker y Fly

[Dockerfile](./Dockerfile) incluye los módulos persistentes y configura el modo.
[fly.toml](./fly.toml) usa una sola máquina, un volumen
`bukeala_browser_data` montado en `/data` y un intervalo de 10 minutos.

El volumen debe existir en la región correspondiente antes de desplegar.
Mantener el mismo volumen entre reinicios y reemplazos; el sistema de archivos
efímero del contenedor no basta. Este servicio no expone un puerto HTTP ni un
endpoint de salud de Fly. El proceso y la telemetría del watcher son las señales
disponibles.

## Criterio de aceptación operativa

Una prueba satisfactoria debe documentar qué versión se ejecutó, en qué host,
cuándo se validó el navegador y cuándo se verificó el Worker. Para afirmar
recuperación autónoma hace falta observar expiraciones reales y recuperación
posterior, además de reiniciar la VM conservando el perfil. Un resultado de
`npm test`, un probe breve o una migración exitosa no sustituye esa observación.

El contexto de la revisión y los límites de los HAR están en
[ESTADO_2026-10-20.md](../ESTADO_2026-10-20.md).
