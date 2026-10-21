import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Use the production HTTP handlers and coordinator. Stub only patient queue
// processing: protocol tests must never execute a booking or patient message.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/handlers/nativeHostEvent.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "no-patient-operations", setup(build) {
    build.onResolve({ filter: /claudeBookingAgent|tgPendingCommands/ }, () => ({ path: "patient-queue-stub", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export async function processPendingRequests() {} export async function procesarComandosPendientes() {}", loader: "js" }));
  } }],
})).outputFiles[0].text;
const handlers = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const KEY = "nativeHost:refreshRequest";

function fixture(t) {
  const data = new Map();
  const messages = [];
  const background = [];
  let telegramOk = true;
  const env = {
    ALLOWED_CHAT_ID: "101", CAPTURE_TOKEN: "synthetic-capture-token", TELEGRAM_BOT_TOKEN: "synthetic-test-token",
    STATE: {
      async get(key) { return data.get(key) ?? null; },
      async put(key, value) { data.set(key, value); },
      async delete(key) { data.delete(key); },
    },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.telegram.org/botsynthetic-test-token/sendMessage");
    const message = JSON.parse(options.body);
    assert.match(message.chat_id, /^-?\d+$/);
    messages.push(message);
    return Response.json({ ok: telegramOk }, { status: telegramOk ? 200 : 503 });
  });
  const context = (body, token = env.CAPTURE_TOKEN) => ({
    env,
    req: { header: () => token, json: async () => body },
    executionCtx: { waitUntil: (promise) => background.push(promise) },
    json: (value, status = 200, headers = {}) => Response.json(value, { status, headers }),
  });
  t.after(() => Promise.all(background));
  return { env, data, messages, context, setTelegramOk: (ok) => { telegramOk = ok; } };
}

test("HTTP handlers accept watcher payload, retain failure, and complete the same request", async (t) => {
  const f = fixture(t);
  await handlers.requestRefresh(f.env, "202");
  const polled = await handlers.handleCheckRefresh(f.context());
  assert.equal(polled.headers.get("cache-control"), "no-store");
  const request = await polled.json();
  assert.equal(request.pending, true);
  const nextAttemptAt = Date.now() + 30 * 60_000;
  const failedBody = { requestedAt: request.requestedAt, ok: false, reasonCode: "login-cooldown", nextAttemptAt, completedAt: new Date().toISOString() };
  const failure = await handlers.handleRefreshComplete(f.context(failedBody));
  assert.deepEqual(await failure.json(), { ok: true, accepted: true, pending: true, nextAttemptAt });
  const afterFailure = f.data.get(KEY);
  const retryCallback = await handlers.handleRefreshComplete(f.context(failedBody));
  assert.equal((await retryCallback.json()).accepted, true);
  assert.equal(f.data.get(KEY), afterFailure, "outbox retry must not count another failure");
  assert.equal((await (await handlers.handleCheckRefresh(f.context())).json()).pending, false);

  const success = await handlers.handleRefreshComplete(f.context({ requestedAt: request.requestedAt, ok: true, completedAt: new Date().toISOString(), nextAttemptAt: Date.now() + 30000 }));
  assert.equal(success.status, 200);
  assert.equal((await success.json()).recovered, true);
  assert.equal(f.data.has(KEY), false);
  assert.equal(f.messages.at(-1).chat_id, "202");
});

test("HTTP failure acknowledgement requests retry when Telegram rejects completion", async (t) => {
  const f = fixture(t);
  await handlers.requestRefresh(f.env, "202");
  const { requestedAt } = await (await handlers.handleCheckRefresh(f.context())).json();
  f.setTelegramOk(false);
  const first = await handlers.handleRefreshComplete(f.context({ requestedAt, ok: true }));
  assert.equal(first.status, 503);
  assert.equal((await first.json()).retryNotification, true);
  assert.equal(f.data.has(KEY), true);
  f.setTelegramOk(true);
  const retry = await handlers.handleRefreshComplete(f.context({ requestedAt, ok: true }));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).accepted, true);
  assert.equal(f.data.has(KEY), false);
});

test("HTTP stale, missing correlation, malformed payload and invalid auth leave request intact", async (t) => {
  const f = fixture(t);
  await handlers.requestRefresh(f.env, "202");
  const original = f.data.get(KEY);
  const stale = await handlers.handleRefreshComplete(f.context({ requestedAt: "2020-01-01T00:00:00.000Z", ok: true }));
  assert.equal((await stale.json()).accepted, false);
  const uncorrelated = await handlers.handleRefreshComplete(f.context({ ok: true }));
  assert.equal((await uncorrelated.json()).reason, "uncorrelated");
  assert.equal((await handlers.handleRefreshComplete(f.context({ ok: "true" }))).status, 400);
  assert.equal((await handlers.handleRefreshComplete(f.context({ ok: true }, "wrong-test-token"))).status, 401);
  assert.equal(f.data.get(KEY), original);
  assert.equal(f.messages.length, 0);
});
