import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Bundle only the recovery coordinator and users reader. All I/O is mocked;
// no Worker, Telegram account, or patient data is contacted by these tests.
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/sessionRecovery.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
}).outputFiles[0].text;
const recovery = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const { requestRecovery, pollRecovery, completeRecovery, notifyRecoveryDelay, closeAutomaticRecovery, validComponentsResponse, getRecoveryStatus } = recovery;
const KEY = "nativeHost:refreshRequest";
const START = Date.UTC(2026, 9, 20, 23);
const MINUTE = 60_000;

function fixture(t) {
  const data = new Map();
  const writes = [];
  const messages = [];
  let network = async () => Response.json({ ok: true });
  const env = {
    ALLOWED_CHAT_ID: "101", TELEGRAM_BOT_TOKEN: "synthetic-test-token",
    STATE: {
      async get(key) { return data.get(key) ?? null; },
      async put(key, value, options) { writes.push({ key, options }); data.set(key, value); },
      async delete(key) { data.delete(key); },
    },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.telegram.org/botsynthetic-test-token/sendMessage");
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.match(body.chat_id, /^-?\d+$/);
    messages.push(body);
    return network(body);
  });
  return {
    env, data, writes, messages,
    request: () => JSON.parse(data.get(KEY) ?? "null"),
    setNetwork: (fn) => { network = fn; },
  };
}

test("status reads pending challenge and cooldown without picking it up or exposing recipients", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const request = f.request();
  await completeRecovery(f.env, {
    requestedAt: request.requestedAt, ok: false, reasonCode: "external-auth-challenge",
    nextAttemptAt: START + 30 * MINUTE,
  }, START + MINUTE);
  const before = f.data.get(KEY);
  const writes = f.writes.length;
  const snapshot = await getRecoveryStatus(f.env, START + 2 * MINUTE);
  assert.deepEqual(snapshot, {
    pending: true, requestedAt: request.requestedAt,
    nextAttemptAt: START + 30 * MINUTE, pickedUp: false, needsHumanAttention: true,
  });
  assert.equal(f.data.get(KEY), before);
  assert.equal(f.writes.length, writes);
  assert.equal(snapshot.requestedBy, undefined);
  assert.equal(snapshot.notifyChatIds, undefined);
});

test("status only reports a recently picked up request while its lease remains current", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await getRecoveryStatus(f.env, START), { pending: false });
  await requestRecovery(f.env, "202", START);
  await pollRecovery(f.env, START);
  assert.equal((await getRecoveryStatus(f.env, START + MINUTE)).pickedUp, true);
  assert.equal((await getRecoveryStatus(f.env, START + 6 * MINUTE)).pickedUp, false);
});

test("human attention persists after challenge then transient failure or cooldown until recovery succeeds", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const { requestedAt } = f.request();
  await completeRecovery(f.env, {
    requestedAt, ok: false, reasonCode: "external-auth-challenge",
  }, START + MINUTE);
  assert.ok(f.request().humanNoticeAt);
  for (const [index, reasonCode] of ["network-failed", "login-cooldown"].entries()) {
    const now = START + (index + 2) * MINUTE;
    await completeRecovery(f.env, { requestedAt, ok: false, reasonCode }, now);
    assert.equal(f.request().lastResult.reasonCode, reasonCode);
    const snapshot = await getRecoveryStatus(f.env, now);
    assert.equal(snapshot.needsHumanAttention, true);
    assert.ok(snapshot.nextAttemptAt > now);
  }
  await completeRecovery(f.env, { requestedAt, ok: true }, START + 4 * MINUTE);
  assert.deepEqual(await getRecoveryStatus(f.env, START + 4 * MINUTE), { pending: false });
});

test("cron coalesces without replacing manual recipient, ID, pickup, or cooldown", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const initial = f.request();
  await pollRecovery(f.env, START + 2000);
  await completeRecovery(f.env, { requestedAt: initial.requestedAt, ok: false, nextAttemptAt: START + 30 * MINUTE }, START + 5000);
  const before = f.request();
  await requestRecovery(f.env, "auto-keepalive-24-7", START + MINUTE);
  assert.deepEqual(f.request(), before);
  assert.equal(before.source, "telegram");
  assert.equal(before.requestedBy, "202");
  assert.equal(before.requestedAt, initial.requestedAt);
  assert.ok(f.writes.every(({ options }) => options.expirationTtl > 3600));
});

test("manual request subscribes to an existing automatic recovery", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "auto-keepalive-24-7", START);
  const id = f.request().requestedAt;
  await requestRecovery(f.env, "202", START + 5000);
  await requestRecovery(f.env, "303", START + 10000);
  await requestRecovery(f.env, "watchdog-pending-stuck", START + 15000);
  assert.equal(f.request().requestedAt, id);
  assert.equal(f.request().source, "auto-keepalive-24-7");
  assert.equal(f.request().requestedBy, "202");
  await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 20000);
  assert.deepEqual(f.messages.map((m) => m.chat_id), ["202", "303"]);
  assert.equal(f.request(), null);
});

test("fast automatic recovery stays silent instead of requesting a manual command", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "auto-keepalive-24-7", START);
  const { requestedAt } = await pollRecovery(f.env, START + 2000);
  await notifyRecoveryDelay(f.env, START + MINUTE);
  const result = await completeRecovery(f.env, { requestedAt, ok: true }, START + MINUTE);
  assert.equal(result.accepted, true);
  assert.equal(f.messages.length, 0);
  assert.equal(f.request(), null);
});

test("sustained automatic incident alerts doctors once and confirms recovery once", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "auto-keepalive-24-7", START);
  const id = f.request().requestedAt;
  await notifyRecoveryDelay(f.env, START + 6 * MINUTE);
  await notifyRecoveryDelay(f.env, START + 9 * MINUTE);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].text, /no necesitas enviar \/sesion_renew/);
  await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 10 * MINUTE);
  await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 11 * MINUTE);
  assert.deepEqual(f.messages.map((m) => m.chat_id), ["101", "101"]);
  assert.match(f.messages[1].text, /recuperada/);
});

test("failure retains the same request until retry deadline and then success", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const first = await pollRecovery(f.env, START + 2000);
  const deadline = START + 31 * MINUTE;
  const failed = await completeRecovery(f.env, { requestedAt: first.requestedAt, ok: false, reasonCode: "login-cooldown", nextAttemptAt: deadline }, START + MINUTE);
  assert.equal(failed.pending, true);
  assert.equal(f.request().pickedUpAt, undefined);
  assert.equal((await pollRecovery(f.env, deadline - 1)).pending, false);
  const retry = await pollRecovery(f.env, deadline);
  assert.equal(retry.pending, true);
  assert.equal(retry.requestedAt, first.requestedAt);
  await completeRecovery(f.env, { requestedAt: retry.requestedAt, ok: true }, deadline + 5000);
  assert.equal(f.request(), null);
  assert.match(f.messages.at(-1).text, /recuperada/);
});

test("human challenge is explicit and automatic retry remains scheduled", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "auto-keepalive-24-7", START);
  const id = f.request().requestedAt;
  await completeRecovery(f.env, { requestedAt: id, ok: false, reasonCode: "external-auth-challenge" }, START + 5000);
  assert.equal(f.messages[0].chat_id, "101");
  assert.match(f.messages[0].text, /verificación humana/);
  assert.equal(f.request().nextAttemptAt, START + 5000 + 30 * MINUTE);
});

test("stale and uncorrelated callbacks cannot clear new protocol requests", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const before = f.request();
  const stale = await completeRecovery(f.env, { requestedAt: new Date(START - MINUTE).toISOString(), ok: true }, START + 5000);
  const legacy = await completeRecovery(f.env, { ok: true }, START + 6000);
  assert.deepEqual([stale.accepted, stale.reason, legacy.accepted, legacy.reason], [false, "stale", false, "uncorrelated"]);
  assert.deepEqual(f.request(), before);
  assert.equal(f.messages.length, 0);
});

test("KV read failure propagates without acknowledging or replacing the pending request", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const original = f.data.get(KEY);
  const id = f.request().requestedAt;
  t.mock.method(f.env.STATE, "get", async () => { throw new Error("synthetic KV outage"); });
  await assert.rejects(completeRecovery(f.env, { requestedAt: id, ok: true }, START + 5000), /synthetic KV outage/);
  await assert.rejects(requestRecovery(f.env, "auto-keepalive-24-7", START + 10000), /synthetic KV outage/);
  await assert.rejects(pollRecovery(f.env, START + 10000), /synthetic KV outage/);
  assert.equal(f.data.get(KEY), original);
  assert.equal(f.messages.length, 0);
});

test("legacy request already in flight still accepts legacy completion", async (t) => {
  const f = fixture(t);
  f.data.set(KEY, JSON.stringify({ requestedAt: new Date(START).toISOString(), requestedBy: "202", pickedUpAt: new Date(START).toISOString() }));
  const result = await completeRecovery(f.env, { ok: true }, START + 5000);
  assert.equal(result.accepted, true);
  assert.equal(f.request(), null);
  assert.equal(f.messages[0].chat_id, "202");
});

test("Telegram HTTP/JSON rejection retains request for durable callback retry", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const id = f.request().requestedAt;
  f.setNetwork(async () => Response.json({ ok: false }, { status: 503 }));
  const rejected = await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 5000);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.retryNotification, true);
  assert.equal(f.request().requestedAt, id);
  f.setNetwork(async () => Response.json({ ok: true }));
  await completeRecovery(f.env, { requestedAt: id, ok: true }, START + MINUTE);
  assert.equal(f.request(), null);
});

test("retry only notifies recipients whose success message was not delivered", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  await requestRecovery(f.env, "303", START + 2000);
  const id = f.request().requestedAt;
  f.setNetwork(async ({ chat_id }) => chat_id === "303"
    ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true }));
  const partial = await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 5000);
  assert.equal(partial.retryNotification, true);
  assert.deepEqual(f.request().successDeliveredChatIds, ["202"]);
  f.setNetwork(async () => Response.json({ ok: true }));
  await completeRecovery(f.env, { requestedAt: id, ok: true }, START + MINUTE);
  assert.deepEqual(f.messages.map((m) => m.chat_id), ["202", "303", "303"]);
  assert.equal(f.request(), null);
});

test("permanent Telegram recipient rejection does not block recovery or cause a retry loop", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const id = f.request().requestedAt;
  f.setNetwork(async () => Response.json({ ok: false, error_code: 403 }, { status: 403 }));
  const result = await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 5000);
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(f.request(), null);
  assert.equal(f.messages.length, 1);
});

test("a new subscriber during success notification receives the result on callback retry", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const id = f.request().requestedAt;
  f.setNetwork(async () => {
    await requestRecovery(f.env, "303", START + 5000);
    return Response.json({ ok: true });
  });
  const partial = await completeRecovery(f.env, { requestedAt: id, ok: true }, START + 5000);
  assert.equal(partial.retryNotification, true);
  assert.deepEqual(f.request().successDeliveredChatIds, ["202"]);
  f.setNetwork(async () => Response.json({ ok: true }));
  await completeRecovery(f.env, { requestedAt: id, ok: true }, START + MINUTE);
  assert.deepEqual(f.messages.map((m) => m.chat_id), ["202", "303"]);
  assert.equal(f.request(), null);
});

test("a later human challenge escalates after a generic failure notice, only once", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const requestedAt = f.request().requestedAt;
  await completeRecovery(f.env, { requestedAt, ok: false, reasonCode: "worker-unverified" }, START + 5000);
  assert.equal(f.messages.length, 1);
  await completeRecovery(f.env, { requestedAt, ok: false, reasonCode: "login-form-unavailable" }, START + 2 * MINUTE);
  assert.deepEqual(f.messages.map((m) => m.chat_id), ["202", "202", "101"]);
  assert.match(f.messages[1].text, /verificación humana/);
  await completeRecovery(f.env, { requestedAt, ok: false, reasonCode: "auth-challenge" }, START + 35 * MINUTE);
  assert.equal(f.messages.length, 3);
});

test("full-login-rejected immediately alerts that human attention may be needed", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "auto-keepalive-24-7", START);
  const requestedAt = f.request().requestedAt;
  await completeRecovery(f.env, { requestedAt, ok: false, reasonCode: "full-login-rejected" }, START + MINUTE);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].chat_id, "101");
  assert.match(f.messages[0].text, /verificación humana/);
  assert.ok(f.request().humanNoticeAt);
});

test("cron escalates a previously acknowledged full-login-rejected once without another attempt", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const request = f.request();
  request.attempts = 2;
  request.nextAttemptAt = START + 60 * MINUTE;
  request.lastResult = { ok: false, at: new Date(START + MINUTE).toISOString(), reasonCode: "full-login-rejected" };
  request.failureNoticeAt = new Date(START + MINUTE).toISOString();
  request.noticeSentAt = new Date(START + 6 * MINUTE).toISOString();
  f.data.set(KEY, JSON.stringify(request));
  await notifyRecoveryDelay(f.env, START + 7 * MINUTE);
  await notifyRecoveryDelay(f.env, START + 10 * MINUTE);
  assert.deepEqual(f.messages.map((m) => m.chat_id), ["202", "101"]);
  assert.ok(f.messages.every((m) => /verificación humana/.test(m.text)));
  assert.equal(f.request().requestedAt, request.requestedAt);
  assert.equal(f.request().attempts, request.attempts);
  assert.equal(f.request().nextAttemptAt, request.nextAttemptAt);
  assert.deepEqual(f.request().lastResult, request.lastResult);
  assert.ok(f.request().humanNoticeAt);
});

test("a different request appearing during notification is not deleted", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const oldId = f.request().requestedAt;
  const replacement = { version: 2, requestedAt: new Date(START + MINUTE).toISOString(), requestedBy: "303", source: "telegram", notifyChatIds: ["303"] };
  f.setNetwork(async () => { f.data.set(KEY, JSON.stringify(replacement)); return Response.json({ ok: true }); });
  await completeRecovery(f.env, { requestedAt: oldId, ok: true }, START + 2 * MINUTE);
  assert.deepEqual(f.request(), replacement);
});

test("verified health closes an automatic incident but leaves manual results to watcher", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "auto-keepalive-24-7", START);
  await notifyRecoveryDelay(f.env, START + 6 * MINUTE);
  await closeAutomaticRecovery(f.env, START + 7 * MINUTE);
  assert.equal(f.request(), null);
  assert.equal(f.messages.length, 2);
  await requestRecovery(f.env, "202", START + 8 * MINUTE);
  await closeAutomaticRecovery(f.env, START + 9 * MINUTE);
  assert.equal(f.request().requestedBy, "202");
});

test("health accepts only HTTP 200 with the authenticated components schema", async () => {
  const healthy = [{ id: 1, code: "TEST", description: "Synthetic component" }];
  assert.equal(await validComponentsResponse(Response.json(healthy)), true);
  for (const response of [
    new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    Response.json(healthy, { status: 500 }),
    Response.json({ error: "unauthorized" }), Response.json([]),
    Response.json([{ id: "1", code: "TEST", description: "bad id" }]),
    new Response("{", { headers: { "content-type": "application/json" } }),
  ]) assert.equal(await validComponentsResponse(response), false);
});

// Antes la orden quedaba en cola EN SILENCIO: el 25/oct/2026 aparecio una del
// Dr. que llevaba 3 horas esperando sin que nadie le dijera nada. La espera es
// deliberada (no se salta), pero hay que poder contarla.
test("pedir renovacion durante la espera devuelve hasta cuando, sin saltarsela", async (t) => {
  const f = fixture(t);
  await requestRecovery(f.env, "202", START);
  const request = f.request();
  await completeRecovery(f.env, {
    requestedAt: request.requestedAt, ok: false, reasonCode: "external-auth-challenge",
    nextAttemptAt: START + 30 * MINUTE,
  }, START + MINUTE);

  const estado = await requestRecovery(f.env, "202", START + 2 * MINUTE);
  assert.equal(estado.esperaHasta, START + 30 * MINUTE, "debe decir hasta cuando espera");

  // Y la espera sigue vigente: la orden no se entrega antes de tiempo.
  const poll = await pollRecovery(f.env, START + 2 * MINUTE);
  assert.equal(poll.pending, false, "no se salta la espera");
  assert.equal(poll.nextAttemptAt, START + 30 * MINUTE);
});

test("sin espera en curso no se inventa una", async (t) => {
  const f = fixture(t);
  const estado = await requestRecovery(f.env, "202", START);
  assert.equal(estado.esperaHasta, undefined);
});
