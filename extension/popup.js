const $ = (id) => document.getElementById(id);

const DEFAULT_WORKER_URL = "https://bukeala-bot.ddropero.workers.dev/capture";
const DEFAULT_CAPTURE_TOKEN = "ff0a8423647055a33737f440390d37a2f35ec90b3a7a8365";

(async () => {
  const stored = await chrome.storage.local.get([
    "workerUrl",
    "captureToken",
    "autoMode",
    "lastAutoSendAt",
    "lastAutoSendOk",
    "lastAutoSendCount",
    "lastCasHeartbeatAt",
    "lastCasHeartbeatStatus",
  ]);
  $("workerUrl").value = stored.workerUrl || DEFAULT_WORKER_URL;
  $("captureToken").value = stored.captureToken || DEFAULT_CAPTURE_TOKEN;
  $("autoMode").checked = !!stored.autoMode;
  const lines = [];
  if (stored.lastAutoSendAt) {
    const dt = new Date(stored.lastAutoSendAt);
    const ago = Math.round((Date.now() - dt.getTime()) / 60000);
    const status = stored.lastAutoSendOk ? "✅" : "❌";
    lines.push(`${status} Último auto-send: hace ${ago} min (${stored.lastAutoSendCount ?? "?"} cookies)`);
  }
  if (stored.lastCasHeartbeatAt) {
    const dt = new Date(stored.lastCasHeartbeatAt);
    const ago = Math.round((Date.now() - dt.getTime()) / 60000);
    const ok = stored.lastCasHeartbeatStatus && stored.lastCasHeartbeatStatus < 400 ? "✅" : "⚠️";
    lines.push(`${ok} CAS heartbeat: hace ${ago} min (status ${stored.lastCasHeartbeatStatus ?? "?"})`);
  }
  if (lines.length > 0) $("lastAuto").innerHTML = lines.join("<br>");
})();

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

$("sendBtn").addEventListener("click", async () => {
  const workerUrl = $("workerUrl").value.trim();
  const captureToken = $("captureToken").value.trim();
  if (!workerUrl || !captureToken) {
    setStatus("URL y token requeridos.", "err");
    return;
  }
  if (!workerUrl.endsWith("/capture")) {
    setStatus("La URL debe terminar en /capture.", "err");
    return;
  }
  await chrome.storage.local.set({ workerUrl, captureToken });

  $("sendBtn").disabled = true;
  setStatus("Enviando...", "");
  try {
    const r = await chrome.runtime.sendMessage({ type: "manual_send" });
    if (r?.ok) {
      const j = r.body || {};
      setStatus(`✅ OK. ${j.cookieCount ?? "?"} cookies. Expira: ${j.expiresAt ?? "?"}`, "ok");
    } else {
      setStatus(`Error: ${r?.reason || "desconocido"}`, "err");
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    $("sendBtn").disabled = false;
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
