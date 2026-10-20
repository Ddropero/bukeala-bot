"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPersistentWatcher } = require("../persistentWatcher");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 0, 1);
const healthy = (extra = {}) => ({
  ok: true,
  authenticated: true,
  published: true,
  workerVerified: true,
  loginAttempted: false,
  via: "persistent",
  ...extra,
});

function fixture(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, "bukeala-watcher-test-"));
  const watchers = [];
  const requests = [];
  const logs = [];
  let clock = START;
  let pending = { pending: false };
  let networkFailure = null;
  const env = {
    WORKER_URL: "https://worker.invalid/capture",
    CAPTURE_TOKEN: "synthetic-test-value",
    BROWSER_PROFILE_DIR: dir,
    PROACTIVE_INTERVAL_MS: String(10 * MINUTE),
    POLL_INTERVAL_MS: String(30_000),
  };
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://worker.invalid");
    assert.equal(parsed.search, "", "authentication must not be put in the URL");
    assert.ok(options.signal instanceof AbortSignal, "every remote request must have a deadline");
    const request = {
      pathname: parsed.pathname,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : null,
      at: clock,
    };
    requests.push(request);
    if (networkFailure?.(request)) throw new Error("simulated network outage");
    return {
      ok: true,
      status: 200,
      json: async () => parsed.pathname === "/native-host/check-refresh" ? pending : { ok: true },
    };
  };
  t.after(async () => {
    for (const watcher of watchers) await watcher.close();
    // Remove only the exact temporary directory created by this fixture.
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("bukeala-watcher-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return {
    dir,
    requests,
    logs,
    env,
    now: () => clock,
    setTime: (value) => { clock = value; },
    advance: (value) => { clock += value; },
    setPending: (value) => { pending = value; },
    failNetworkWhen: (value) => { networkFailure = value; },
    create(manager) {
      const watcher = createPersistentWatcher(env, {
        manager,
        fetch,
        now: () => clock,
        log: (level, message, meta) => logs.push({ level, message, meta }),
      });
      watchers.push(watcher);
      return watcher;
    },
  };
}

test("24 offline simulated hours: expiry at 6/12/18h and restart do not need the user's browser", async (t) => {
  const f = fixture(t);
  const stateFile = path.join(f.dir, "simulated-server-session.json");
  const expiries = [6 * HOUR, 12 * HOUR, 18 * HOUR].map((offset) => START + offset);
  const loginTimes = [];
  const renewalTimes = [];
  const managers = [];

  // This models the manager's durable authentication contract. It deliberately
  // has no API to obtain a session from the PC/extension. Real Chromium/profile
  // persistence is tested independently by the session manager's test suite.
  function createManager() {
    const manager = {
      closed: false,
      closeCalls: 0,
      async renew() {
        assert.equal(this.closed, false, "a closed browser must never be reused");
        let saved;
        try { saved = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
        catch { saved = { authenticated: false, expiredThrough: -1 }; }
        const expiredThrough = expiries.reduce((last, time, index) => f.now() >= time ? index : last, -1);
        const loginAttempted = !saved.authenticated || expiredThrough > saved.expiredThrough;
        if (loginAttempted) loginTimes.push(f.now());
        fs.writeFileSync(stateFile, JSON.stringify({ authenticated: true, expiredThrough }));
        renewalTimes.push(f.now());
        return healthy({ loginAttempted });
      },
      async close() {
        this.closed = true;
        this.closeCalls++;
      },
    };
    managers.push(manager);
    return manager;
  }

  let watcher = f.create(createManager());
  assert.equal((await watcher.runCycle("startup")).ok, true);
  for (let minute = 1; minute <= 24 * 60; minute++) {
    f.setTime(START + minute * MINUTE);
    await watcher.tick();
    if (minute === 9 * 60) {
      const before = watcher.getStatus();
      await watcher.close();
      watcher = f.create(createManager());
      assert.equal(watcher.getStatus().successfulCycles, before.successfulCycles);
      assert.equal(watcher.getStatus().fullLogins, before.fullLogins);
      const startup = await watcher.runCycle("startup");
      assert.equal(startup.ok, true, "restart must reopen a healthy profile immediately");
    }
  }

  assert.deepEqual(loginTimes, [START, ...expiries]);
  assert.equal(renewalTimes.length, 146, "initial cycle, 144 ten-minute renewals, and immediate restart recovery");
  let immediateRestartCycles = 0;
  for (let index = 1; index < renewalTimes.length; index++) {
    const elapsed = renewalTimes[index] - renewalTimes[index - 1];
    if (elapsed === 0 && renewalTimes[index] === START + 9 * HOUR) immediateRestartCycles++;
    else assert.equal(elapsed, 10 * MINUTE);
  }
  assert.equal(immediateRestartCycles, 1);
  assert.equal(watcher.getStatus().successfulCycles, 146);
  assert.equal(watcher.getStatus().fullLogins, 4);
  assert.equal(watcher.getStatus().failures, 0);
  assert.equal(managers.length, 2, "only the explicit process restart replaces the manager");
  assert.equal(managers[0].closeCalls, 1);
  assert.equal(managers[1].closeCalls, 0, "age or renewal count must not close a healthy browser");
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every((request) => [
    "/native-host/check-refresh",
    "/native-host/event",
  ].includes(request.pathname)), "no session adoption/TGC/extension endpoints are used");
  assert.ok(f.requests.filter((request) => request.pathname === "/native-host/event")
    .every((request) => request.body.type === "ok"));
  await watcher.close();
  assert.equal(managers[1].closeCalls, 1);
});

test("restart within the success throttle reopens the profile immediately without bypassing normal throttling", async (t) => {
  const f = fixture(t);
  let renewCalls = 0;
  const manager = () => ({
    renew: async () => { renewCalls++; return healthy(); },
    close: async () => {},
  });
  const first = f.create(manager());
  assert.equal((await first.runCycle("startup")).ok, true);
  const previousDeadline = first.getStatus().nextAttemptAt;
  assert.equal(previousDeadline, START + 30_000);
  await first.close();

  f.advance(5_000);
  const restarted = f.create(manager());
  assert.equal(restarted.getStatus().nextAttemptAt, previousDeadline);
  assert.ok(f.now() < previousDeadline);
  assert.equal((await restarted.runCycle("startup")).ok, true);
  assert.equal(renewCalls, 2, "the new process must open the browser before the old ten-minute schedule");
  assert.equal(restarted.getStatus().successfulCycles, 2);
  assert.equal(restarted.getStatus().nextScheduledAt, f.now() + 10 * MINUTE);

  assert.equal((await restarted.runCycle("on-demand")).reason, "backoff");
  assert.equal((await restarted.runCycle("scheduled")).reason, "backoff");
  await restarted.tick();
  assert.equal(renewCalls, 2, "only startup may skip the successful-cycle throttle");
});

for (const missing of ["ok", "authenticated", "published", "workerVerified"]) {
  test(`incomplete session result (${missing}=false) must not report success or close the browser`, async (t) => {
    const f = fixture(t);
    let closeCalls = 0;
    const watcher = f.create({
      renew: async () => healthy({ [missing]: false }),
      close: async () => { closeCalls++; },
    });
    const result = await watcher.runCycle("startup");
    assert.equal(result.ok, false);
    assert.equal(watcher.getStatus().successfulCycles, 0);
    assert.equal(watcher.getStatus().failures, 1);
    assert.equal(watcher.getStatus().lastSuccessAt, undefined);
    assert.equal(watcher.getStatus().nextAttemptAt, START + 90_000);
    assert.equal(closeCalls, 0);
    const events = f.requests.filter((request) => request.pathname === "/native-host/event");
    assert.equal(events.length, 1);
    assert.equal(events[0].body.type, "error");
  });
}

test("exceptions become failures; restart and on-demand requests cannot bypass backoff", async (t) => {
  const f = fixture(t);
  let renewCalls = 0;
  const failing = f.create({
    renew: async () => { renewCalls++; throw new Error("simulated browser exception"); },
    close: async () => {},
  });
  assert.equal((await failing.runCycle("startup")).reasonCode, "cycle_exception");
  f.setPending({ pending: true, requestedAt: "synthetic-request-1" });
  f.advance(30_000);
  const callsBefore = f.requests.length;
  await failing.tick();
  assert.equal(f.requests.length, callsBefore, "backoff must not pick up a remote request early");
  assert.equal(renewCalls, 1);
  await failing.close();

  const recovered = f.create({
    renew: async () => { renewCalls++; return healthy(); },
    close: async () => {},
  });
  assert.equal((await recovered.runCycle("startup")).reason, "backoff");
  f.setTime(START + 89_999);
  await recovered.tick();
  assert.equal(renewCalls, 1);
  f.setTime(START + 90_000);
  await recovered.tick();
  assert.equal(renewCalls, 2);
  assert.equal(recovered.getStatus().successfulCycles, 1);
  assert.equal(recovered.getStatus().failures, 0);
  const completed = f.requests.filter((request) => request.pathname === "/native-host/refresh-complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].body.ok, true);

  f.advance(30_000);
  await recovered.tick();
  assert.equal(renewCalls, 2, "the same remote request must not be processed twice");
});

test("authentication failures receive a persistent, increasing cooldown even with pending remote work", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const manager = {
    renew: async () => {
      calls++;
      return { ok: false, authenticated: false, loginAttempted: true, reasonCode: "credentials_rejected" };
    },
    close: async () => {},
  };
  let watcher = f.create(manager);
  assert.equal((await watcher.runCycle("startup")).ok, false);
  assert.equal(watcher.getStatus().nextAttemptAt, START + 30 * MINUTE);
  f.setPending({ pending: true, requestedAt: "pending-during-auth-failure" });
  for (let minute = 1; minute < 30; minute++) {
    f.setTime(START + minute * MINUTE);
    await watcher.tick();
  }
  assert.equal(calls, 1);
  f.setTime(START + 30 * MINUTE);
  await watcher.tick();
  assert.equal(calls, 2);
  assert.equal(watcher.getStatus().nextAttemptAt, START + 90 * MINUTE);
  assert.equal(watcher.getStatus().fullLogins, 0, "rejected attempts must not count as completed logins");
  const completions = f.requests.filter((request) => request.pathname === "/native-host/refresh-complete");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].body.ok, false);

  await watcher.close();
  watcher = f.create(manager);
  f.setTime(START + 31 * MINUTE);
  assert.equal((await watcher.runCycle("startup")).reason, "backoff");
  assert.equal(calls, 2);
  assert.equal(watcher.getStatus().nextAttemptAt, START + 90 * MINUTE);
});

test("telemetry and refresh-check outages do not discard a verified browser or block later scheduled work", async (t) => {
  const f = fixture(t);
  let renewCalls = 0;
  let closeCalls = 0;
  const watcher = f.create({
    renew: async () => { renewCalls++; return healthy(); },
    close: async () => { closeCalls++; },
  });
  f.failNetworkWhen(() => true);
  assert.equal((await watcher.runCycle("startup")).ok, true);
  assert.equal(watcher.getStatus().successfulCycles, 1);
  assert.equal(watcher.getStatus().failures, 0);
  f.advance(10 * MINUTE);
  await watcher.tick();
  assert.equal(renewCalls, 2);
  assert.equal(watcher.getStatus().successfulCycles, 2);
  assert.equal(closeCalls, 0);
  assert.ok(f.logs.some((entry) => entry.level === "warn"));
});

test("concurrent requests share one in-flight renewal and close is idempotent", async (t) => {
  const f = fixture(t);
  let resolveRenewal;
  let renewCalls = 0;
  let closeCalls = 0;
  const watcher = f.create({
    renew: () => {
      renewCalls++;
      return new Promise((resolve) => { resolveRenewal = resolve; });
    },
    close: async () => { closeCalls++; },
  });
  const first = watcher.runCycle("startup");
  assert.equal((await watcher.runCycle("on-demand")).skipped, true);
  await watcher.tick();
  assert.equal(renewCalls, 1);
  resolveRenewal(healthy());
  assert.equal((await first).ok, true);
  assert.equal(watcher.getStatus().successfulCycles, 1);
  await watcher.close();
  await watcher.close();
  assert.equal(closeCalls, 1);
  assert.equal((await watcher.runCycle("scheduled")).skipped, true);
});
