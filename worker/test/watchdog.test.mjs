import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the production watchdog and recovery coordinator with no patients.
// All outbound calls are intercepted; these tests cannot message real users.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/cron/watchdog.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "no-patient-operations", setup(build) {
    build.onResolve({ filter: /claudeBookingAgent|tgPendingCommands/ }, () => ({ path: "patient-queue-stub", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
      contents: "export async function loadPendingRequests() { return []; } export async function processPendingRequests() {} export async function procesarComandosPendientes() {}",
      loader: "js",
    }));
  } }],
})).outputFiles[0].text;
const { watchdogCron } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);

const REQUEST_KEY = "nativeHost:refreshRequest";
const ALERT_KEY = "watchdog:renewerStaleAlerted";
const EVENTS_KEY = "nativeHost:events";
const MINUTE = 60000;
const LAST_EVENT = Date.parse("2026-10-21T01:24:33.035Z"); // 20:24 Bogotá.
const ALERT_TIME = Date.parse("2026-10-21T02:00:00Z"); // Screenshot: 21:00 Bogotá.
const NEXT_ATTEMPT = Date.parse("2026-10-21T02:24:33.035Z"); // 21:24 Bogotá.

function pendingRecovery() {
  return {
    version: 2,
    requestedAt: "2026-10-21T00:53:01.597Z",
    requestedBy: "101",
    source: "auto-validation",
    nextAttemptAt: NEXT_ATTEMPT,
    attempts: 2,
    humanNoticeAt: "2026-10-21T00:54:16Z",
    lastResult: { ok: false, at: new Date(LAST_EVENT).toISOString(), reasonCode: "auth-challenge" },
  };
}

function fixture(t, { recovery = null, now = ALERT_TIME } = {}) {
  const data = new Map([[EVENTS_KEY, JSON.stringify([
    { type: "error", at: new Date(LAST_EVENT).toISOString(), via: "persistent", message: "persistent: auth-challenge" },
  ])]]);
  if (recovery) data.set(REQUEST_KEY, JSON.stringify(recovery));
  const messages = [];
  const writes = [];
  let readErrorKey;
  let writeErrorKey;
  const env = {
    ALLOWED_CHAT_ID: "101",
    TELEGRAM_BOT_TOKEN: "synthetic-watchdog-test-token",
    STATE: {
      async get(key) {
        if (key === readErrorKey) throw new Error("synthetic KV unavailable");
        return data.get(key) ?? null;
      },
      async put(key, value) {
        if (key === writeErrorKey) throw new Error("synthetic KV write failure");
        writes.push({ key, value });
        data.set(key, value);
      },
      async delete(key) { data.delete(key); },
    },
  };
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.telegram.org/botsynthetic-watchdog-test-token/sendMessage");
    const message = JSON.parse(options.body);
    assert.equal(message.chat_id, "101");
    messages.push(message);
    return Response.json({ ok: true });
  });
  return {
    env, data, messages, writes,
    setNow: (value) => { now = value; },
    failReads: (key) => { readErrorKey = key; },
    failWrites: (key) => { writeErrorKey = key; },
  };
}

test("the 20:24 report with a 21:24 retry does not produce the false 21:00 alert", async (t) => {
  const f = fixture(t, { recovery: pendingRecovery() });
  const original = f.data.get(REQUEST_KEY);
  f.data.set(ALERT_KEY, "1");
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 0);
  assert.equal(f.data.get(REQUEST_KEY), original, "do not replace the request or extend its retry deadline");
  assert.equal(f.writes.filter(({ key }) => key === REQUEST_KEY).length, 0, "do not request another refresh during cooldown");
  assert.equal(f.data.get(ALERT_KEY), "1", "waiting is not new proof of VM health");
});

test("allows five minutes to publish the retry result, then detects missing reports", async (t) => {
  const f = fixture(t, { recovery: pendingRecovery(), now: NEXT_ATTEMPT + 5 * MINUTE - 1 });
  const original = f.data.get(REQUEST_KEY);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 0);
  f.setNow(NEXT_ATTEMPT + 5 * MINUTE);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 1, "human-attention status must not suppress missing-report alerts indefinitely");
  assert.equal(f.data.get(REQUEST_KEY), original);
  assert.match(f.messages[0].text, /no tiene un nuevo reporte/);
  assert.match(f.messages[0].text, /Esto no confirma que la VM esté apagada/);
  assert.doesNotMatch(f.messages[0].text, /dejan de funcionar|colgada|Ya pedí/);
});

test("a genuinely stale report without recovery requests one and alerts once", async (t) => {
  const f = fixture(t);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 1);
  assert.equal(f.data.get(ALERT_KEY), "1");
  const request = JSON.parse(f.data.get(REQUEST_KEY));
  assert.equal(request.requestedBy, "watchdog-renovador-mudo");
  assert.match(f.messages[0].text, /recuperación quedó solicitada/);
  f.setNow(ALERT_TIME + 15 * MINUTE);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 1, "keep the existing alert throttle");
  assert.deepEqual(JSON.parse(f.data.get(REQUEST_KEY)), request);
});

test("a fresh event clears the stale-alert marker and allows a later independent alert", async (t) => {
  const f = fixture(t);
  f.data.set(ALERT_KEY, "1");
  f.data.set(EVENTS_KEY, JSON.stringify([{ type: "ok", at: new Date(ALERT_TIME).toISOString(), via: "persistent" }]));
  await watchdogCron(f.env);
  assert.equal(f.data.has(ALERT_KEY), false);
  assert.equal(f.messages.length, 0);
  f.setNow(ALERT_TIME + 25 * MINUTE);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 1);
});

test("unavailable recovery data gives no invented VM diagnosis or healthy reset", async (t) => {
  const f = fixture(t);
  f.data.set(ALERT_KEY, "1");
  f.failReads(REQUEST_KEY);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 0);
  assert.equal(f.data.get(ALERT_KEY), "1");
  assert.equal(f.writes.length, 0);
});

test("a failed refresh write is reported without claiming a request was saved", async (t) => {
  const f = fixture(t);
  f.failWrites(REQUEST_KEY);
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /No pude confirmar que se guardara la solicitud/);
  assert.doesNotMatch(f.messages[0].text, /recuperación quedó solicitada/);
  assert.equal(f.data.has(REQUEST_KEY), false);
});

test("a malformed or implausibly distant retry deadline cannot hide a stale reporter", async (t) => {
  const f = fixture(t, { recovery: { ...pendingRecovery(), nextAttemptAt: "invalid" } });
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 1);
  f.data.delete(ALERT_KEY);
  f.data.set(REQUEST_KEY, JSON.stringify({ ...pendingRecovery(), nextAttemptAt: ALERT_TIME + 24 * 60 * MINUTE }));
  await watchdogCron(f.env);
  assert.equal(f.messages.length, 2);
});
