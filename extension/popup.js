const $ = (id) => document.getElementById(id);

const DEFAULT_WORKER_URL = "https://bukeala-bot.ddropero.workers.dev/capture";
const DEFAULT_CAPTURE_TOKEN = "ff0a8423647055a33737f440390d37a2f35ec90b3a7a8365";

// Minutos transcurridos desde una fecha ISO (o null si no hay dato).
function minutosDesde(iso) {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

// Pinta el bloque grande VIVA / CAÍDA / cargando y decide si mostrar la acción
// de "vuelve a iniciar sesión". El veredicto viene del Worker (/debug/measure).
function pintarEstado(modo, textoDetalle) {
  const est = $("estado");
  est.className = "estado " + modo; // viva | caida | cargando
  est.textContent =
    modo === "viva" ? "Sesión VIVA" :
    modo === "caida" ? "Sesión CAÍDA" :
    "Consultando estado…";
  $("detalle").textContent = textoDetalle || "";
  // La acción de re-login solo aparece cuando de verdad hace falta un humano.
  $("accionLogin").hidden = modo !== "caida";
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

// Carga config + últimos envíos, y consulta el estado real al abrir el popup.
(async () => {
  const stored = await chrome.storage.local.get([
    "workerUrl",
    "captureToken",
    "autoMode",
    "lastSuccessAt",
    "lastCasHeartbeatAt",
    "lastCasHeartbeatStatus",
  ]);
  $("workerUrl").value = stored.workerUrl || DEFAULT_WORKER_URL;
  $("captureToken").value = stored.captureToken || DEFAULT_CAPTURE_TOKEN;
  $("autoMode").checked = !!stored.autoMode;

  // Resumen de últimos eventos (sin jerga técnica dura).
  const lines = [];
  const okMin = minutosDesde(stored.lastSuccessAt);
  lines.push(
    okMin === null
      ? "Aún no hay un envío exitoso registrado."
      : `Último envío exitoso: hace ${okMin} min.`,
  );
  const hbMin = minutosDesde(stored.lastCasHeartbeatAt);
  if (hbMin !== null) {
    const ok = stored.lastCasHeartbeatStatus && stored.lastCasHeartbeatStatus < 400;
    lines.push(`${ok ? "✅" : "⚠️"} Latido CAS: hace ${hbMin} min.`);
  }
  $("lastAuto").innerHTML = lines.join("<br>");

  await refrescarEstado();
})();

// Pregunta al background el veredicto del Worker y pinta VIVA/CAÍDA.
async function refrescarEstado() {
  const workerUrl = $("workerUrl").value.trim();
  const captureToken = $("captureToken").value.trim();
  if (!workerUrl || !captureToken) {
    pintarEstado("cargando", "Configura Worker URL y token abajo.");
    $("accionLogin").hidden = true;
    return;
  }
  pintarEstado("cargando", "");
  try {
    const r = await chrome.runtime.sendMessage({ type: "check_alive" });
    if (r && r.known) {
      if (r.alive) pintarEstado("viva", "El bot puede usar la sesión ahora mismo.");
      else pintarEstado("caida", "El bot no puede usar la sesión.");
    } else {
      pintarEstado("cargando", "No se pudo consultar el estado (revisa tu conexión).");
      $("accionLogin").hidden = true;
    }
  } catch (e) {
    pintarEstado("cargando", "No se pudo consultar el estado.");
    $("accionLogin").hidden = true;
  }
}

// Botón grande: renovar/enviar la sesión ahora.
$("sendBtn").addEventListener("click", async () => {
  const workerUrl = $("workerUrl").value.trim();
  const captureToken = $("captureToken").value.trim();
  if (!workerUrl || !captureToken) {
    setStatus("URL y token requeridos (abajo, en Configuración).", "err");
    return;
  }
  if (!workerUrl.endsWith("/capture")) {
    setStatus("La URL debe terminar en /capture.", "err");
    return;
  }
  await chrome.storage.local.set({ workerUrl, captureToken });

  $("sendBtn").disabled = true;
  setStatus("Enviando…", "");
  try {
    const r = await chrome.runtime.sendMessage({ type: "manual_send" });
    if (r?.ok) {
      const j = r.body || {};
      setStatus(`✅ OK. ${j.cookieCount ?? "?"} cookies. Expira: ${j.expiresAt ?? "?"}`, "ok");
    } else if (r?.status === 409) {
      // Guardia del Worker: no es una falla, es protección. La sesión buena
      // (la que mantiene la VM 24/7) sigue en pie.
      setStatus(`🛡️ No se envió: ${r.reason}`, "");
    } else {
      const detail = r?.reason || r?.body?.detail || r?.body?.error || "desconocido";
      setStatus(`Error: ${detail}`, "err");
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    $("sendBtn").disabled = false;
    await refrescarEstado(); // repinta VIVA/CAÍDA tras el intento
  }
});

// Botón de la zona caída: abrir Bukeala para que el médico inicie sesión.
$("loginBtn").addEventListener("click", async () => {
  setStatus("Abriendo Bukeala…", "");
  try {
    await chrome.runtime.sendMessage({ type: "open_login" });
    setStatus("Inicia sesión en la pestaña que se abrió y espera unos segundos.", "");
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  }
});

$("autoMode").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  // Make sure config is saved before activating
  const workerUrl = $("workerUrl").value.trim();
  const captureToken = $("captureToken").value.trim();
  if (enabled && (!workerUrl || !captureToken)) {
    setStatus("Configura Worker URL y token antes de activar auto-modo.", "err");
    e.target.checked = false;
    return;
  }
  await chrome.storage.local.set({ workerUrl, captureToken });
  await chrome.runtime.sendMessage({ type: "set_auto_mode", enabled });
  setStatus(enabled ? "Auto-modo ON ✅" : "Auto-modo OFF", enabled ? "ok" : "");
});
