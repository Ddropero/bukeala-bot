import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Handler real de /native-host/event. Solo se stubea la cola de pacientes: estas
// pruebas nunca agendan ni escriben a un paciente; Telegram está interceptado.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/handlers/nativeHostEvent.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "no-patient-operations", setup(build) {
    build.onResolve({ filter: /claudeBookingAgent|tgPendingCommands/ }, () => ({ path: "patient-queue-stub", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export async function processPendingRequests() {} export async function procesarComandosPendientes() {}", loader: "js" }));
  } }],
})).outputFiles[0].text;
const handlers = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const MINUTE = 60000;
const START = Date.parse("2026-11-17T12:00:00Z");

function fixture(t) {
  const data = new Map();
  const messages = [];
  const background = [];
  let now = START;
  const env = {
    ALLOWED_CHAT_ID: "101", CAPTURE_TOKEN: "synthetic-capture-token", TELEGRAM_BOT_TOKEN: "synthetic-test-token",
    STATE: {
      async get(key) { return data.get(key) ?? null; },
      async put(key, value) { data.set(key, value); },
      async delete(key) { data.delete(key); },
    },
  };
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.telegram.org/botsynthetic-test-token/sendMessage");
    messages.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  });
  const post = (body) => handlers.handleNativeHostEvent({
    env,
    req: { header: () => env.CAPTURE_TOKEN, json: async () => body },
    executionCtx: { waitUntil: (promise) => background.push(promise) },
    json: (value, status = 200) => Response.json(value, { status }),
  });
  t.after(() => Promise.all(background));
  return { messages, post, setNow: (v) => { now = v; } };
}

const timeout = (at, etapa = "profile") => ({
  type: "error", via: "persistent", at: new Date(at).toISOString(), reasonCode: "cycle-timeout", stage: etapa,
  message: `persistent: cycle-timeout (etapa ${etapa}, deadline)`,
});
const loop = (messages) => messages.filter((m) => /colgando en bucle/.test(m.text));

test("dos cycle-timeout seguidos avisan al Dr. con la etapa y un paso hecho desde el celular", async (t) => {
  const f = fixture(t);
  await f.post(timeout(START));
  assert.equal(loop(f.messages).length, 0, "un solo cuelgue puede arreglarse con el reinicio");
  f.setNow(START + 18 * MINUTE);
  await f.post(timeout(START + 18 * MINUTE));
  const alerts = loop(f.messages);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chat_id, "101");
  assert.match(alerts[0].text, /2 reinicios seguidos/);
  assert.match(alerts[0].text, /<code>profile<\/code>/);
  assert.match(alerts[0].text, /console\.cloud\.google\.com/);
  assert.match(alerts[0].text, /Restablecer/);
});

test("el aviso de bucle tiene throttle de 3 h y vuelve a sonar si el bucle sigue", async (t) => {
  const f = fixture(t);
  for (let m = 0; m < 3 * 60; m += 18) {
    f.setNow(START + m * MINUTE);
    await f.post(timeout(START + m * MINUTE));
  }
  assert.equal(loop(f.messages).length, 1);
  // El primer aviso salió en el minuto 18; 3 h después ya puede repetir.
  f.setNow(START + 3 * 60 * MINUTE + 36 * MINUTE);
  await f.post(timeout(START + 3 * 60 * MINUTE + 36 * MINUTE));
  assert.equal(loop(f.messages).length, 2);
});

test("un evento útil entre dos cycle-timeout corta la racha: no es un bucle", async (t) => {
  const f = fixture(t);
  await f.post(timeout(START));
  await f.post({ type: "ok", via: "persistent", at: new Date(START + 5 * MINUTE).toISOString(), message: "persistent: navegador y Worker verificados" });
  await f.post(timeout(START + 30 * MINUTE));
  assert.equal(loop(f.messages).length, 0);
});

test("una etapa fuera de la lista cerrada no se repite al Dr.", async (t) => {
  const f = fixture(t);
  await f.post(timeout(START, "<b>x</b>"));
  await f.post(timeout(START + 18 * MINUTE, "inventada"));
  const alerts = loop(f.messages);
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].text, /inventada|<b>x/);
});

test("helpers: solo error con cycle-timeout cuenta, y la racha se mide desde el final", () => {
  assert.equal(handlers.isCycleTimeoutEvent({ type: "ok", message: "cycle-timeout" }), false);
  assert.equal(handlers.isCycleTimeoutEvent({ type: "error", message: "persistent: auth-challenge" }), false);
  assert.equal(handlers.isCycleTimeoutEvent(timeout(START)), true);
  assert.equal(handlers.trailingCycleTimeouts([timeout(START), { type: "ok" }, timeout(START), timeout(START)]), 2);
  assert.equal(handlers.trailingCycleTimeouts([]), 0);
});
