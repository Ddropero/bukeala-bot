const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createPersistentSessionManager, safeLocation } = require("./persistentSession");
const { sessionHelpers } = require("./autoLogin");

const HOME = sessionHelpers.BUKEALA_HOME;
const CAS = "https://app01.colsanitas.com/cas/login?ticket=SECRET_TICKET";
const COOKIE = { name: "JSESSIONID", value: "SYNTHETIC_COOKIE_SECRET", domain: "appoint.tuscitasmedicas.com", path: "/", expires: -1 };
const COMPONENTS = [{ id: 1218, code: "test-code", description: "Synthetic component" }];

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bukeala-persistent-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { launch: [], submit: [], push: 0, worker: 0, addCookies: 0, logs: [] };
  const config = {
    startAuthenticated: true, submitFailure: false, pushFailure: false,
    workerResult: { ok: true }, responseBody: null, ...overrides,
  };
  let timestamp = Date.parse("2026-10-20T15:00:00Z");
  let active;
  const chromium = {
    async launchPersistentContext(profile, options) {
      calls.launch.push({ profile, options });
      const cookieFile = path.join(profile, "synthetic-browser-state.json");
      const restored = fs.existsSync(cookieFile) ? JSON.parse(fs.readFileSync(cookieFile, "utf8")) : null;
      class FakeContext extends EventEmitter {
        constructor() {
          super();
          this.jar = restored || (config.startAuthenticated ? [{ ...COOKIE }] : []);
          this.authenticated = this.jar.length > 0;
          this.closed = false;
          this.page = {
            current: HOME,
            url: () => this.page.current,
            isClosed: () => this.closed,
            goto: async () => {
              if (config.navigationFailure) throw new Error("https://app01.colsanitas.com/cas/login?ticket=SECRET_TICKET");
              this.page.current = this.authenticated ? HOME : CAS;
            },
            waitForTimeout: async () => {},
            locator: () => ({ first: () => ({ waitFor: async () => {
              if (config.loginFormMissing) throw new Error("No visible login form");
            } }) }),
          };
          this.request = {
            get: async () => ({
              status: () => config.responseStatus || (this.authenticated ? 200 : 302),
              text: async () => config.responseBody === null ? JSON.stringify(COMPONENTS) : config.responseBody,
            }),
          };
        }
        pages() { return [this.page]; }
        async newPage() { return this.page; }
        async cookies() { return this.jar; }
        async addCookies(cookies) {
          calls.addCookies++;
          this.jar = cookies;
          this.authenticated = cookies.some(cookie => cookie.name === "JSESSIONID");
        }
        async clearCookies(filter) {
          this.jar = this.jar.filter(cookie =>
            !(cookie.name === filter.name && cookie.domain === filter.domain && cookie.path === filter.path));
          this.authenticated = this.jar.some(cookie => cookie.name === COOKIE.name && cookie.domain === COOKIE.domain);
        }
        async close() {
          fs.writeFileSync(cookieFile, JSON.stringify(this.jar));
          this.closed = true;
          this.emit("close");
        }
      }
      active = new FakeContext();
      return active;
    },
  };
  const env = {
    BROWSER_PROFILE_DIR: path.join(dir, "profile"),
    ENABLE_FULL_LOGIN: "1",
    CAS_USERNAME: "SYNTHETIC_USERNAME_SECRET",
    CAS_PASSWORD: "SYNTHETIC_PASSWORD_SECRET",
    TWO_CAPTCHA_API_KEY: "SYNTHETIC_CAPTCHA_SECRET",
    WORKER_URL: "https://example.invalid/capture",
    CAPTURE_TOKEN: "SYNTHETIC_CAPTURE_SECRET",
    log: (level, message, metadata) => calls.logs.push({ level, message, metadata }),
  };
  const helpers = {
    async submitCasForm(page, creds, key, log) {
      calls.submit.push({ page, context: active });
      assert.equal(creds.username, env.CAS_USERNAME);
      assert.equal(key, env.TWO_CAPTCHA_API_KEY);
      log("warn", "https://example.invalid/?ticket=SECRET_TICKET", {
        tail: "SYNTHETIC_COOKIE_SECRET", password: env.CAS_PASSWORD,
        error: `${CAS} ${env.CAS_PASSWORD}`, status: 403,
      });
      if (config.submitFailure) throw new Error(`${CAS} ${env.CAS_PASSWORD} SYNTHETIC_COOKIE_SECRET`);
      active.authenticated = true;
      active.jar = [{ ...COOKIE }];
      page.current = HOME;
    },
    async captureAndPush(context) {
      calls.push++;
      assert.equal(context, active);
      if (config.pushFailure) throw new Error("https://example.invalid/?token=SYNTHETIC_CAPTURE_SECRET");
      return context.jar.length;
    },
    async verifyViaWorker(_url, _token, _log, options) {
      calls.worker++;
      assert.equal(options.strict, true);
      return config.workerResult;
    },
  };
  function manager(options = {}) {
    return createPersistentSessionManager(env, { chromium, helpers, now: () => timestamp, ...options });
  }
  return {
    env, manager, calls, config,
    context: () => active,
    advance: ms => { timestamp += ms; },
    now: () => timestamp,
  };
}

test("persistent profile survives manager restart without importing stale cookies", async t => {
  const f = fixture(t);
  let manager = f.manager();
  assert.equal((await manager.renew()).published, true);
  await manager.close();
  const marker = path.join(f.env.BROWSER_PROFILE_DIR, "keep-this-file");
  fs.writeFileSync(marker, "preserve");
  manager = f.manager();
  assert.equal((await manager.renew()).authenticated, true);
  assert.equal(f.calls.launch.length, 2);
  assert.equal(f.calls.launch[0].profile, f.calls.launch[1].profile);
  assert.equal(fs.readFileSync(marker, "utf8"), "preserve");
  assert.equal(f.calls.addCookies, 0);
  assert.equal(f.calls.submit.length, 0);
  for (const { options } of f.calls.launch) {
    assert.equal(options.userAgent, undefined);
    assert.equal(options.args.some(arg => arg.includes("AutomationControlled")), false);
    assert.ok(options.args.includes("--restore-last-session"));
  }
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.env.BROWSER_PROFILE_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.env.BROWSER_PROFILE_DIR, "session-keeper.json")).mode & 0o777, 0o600);
  }
  await manager.close();
});

test("expired session logs in once within the same persistent context", async t => {
  const f = fixture(t);
  const manager = f.manager();
  await manager.renew();
  const original = f.context();
  original.authenticated = false;
  const result = await manager.renew();
  assert.equal(result.ok, true);
  assert.equal(result.via, "persistent-login");
  assert.equal(result.loginAttempted, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.published, true);
  assert.equal(f.calls.submit.length, 1);
  assert.equal(f.calls.submit[0].context, original);
  assert.equal(f.calls.launch.length, 1);
  assert.equal(f.calls.addCookies, 0);
  await manager.close();
});

test("full login requires an explicit environment flag", async t => {
  const f = fixture(t, { startAuthenticated: false });
  delete f.env.ENABLE_FULL_LOGIN;
  const manager = f.manager();
  const result = await manager.renew();
  assert.equal(result.reasonCode, "full-login-disabled");
  assert.equal(result.needsFullLogin, true);
  assert.equal(result.loginAttempted, false);
  assert.equal(f.calls.submit.length, 0);
  assert.equal(f.calls.push, 0);
  await manager.close();
});

test("headed configuration persists and an explicit option can override it", async t => {
  const f = fixture(t);
  f.env.BROWSER_HEADLESS = "0";
  let manager = f.manager();
  await manager.renew();
  assert.equal(f.calls.launch[0].options.headless, false);
  assert.equal(f.calls.launch[0].options.viewport, null);
  await manager.close();
  manager = f.manager({ headless: true });
  await manager.renew();
  assert.equal(f.calls.launch[1].options.headless, true);
  assert.deepEqual(f.calls.launch[1].options.viewport, { width: 1366, height: 800 });
  await manager.close();
});

test("controlled session-loss probe preserves CAS and cannot be used by the publishing service", async t => {
  const f = fixture(t);
  const production = f.manager({ expiryProbe: true });
  assert.equal(production.simulateAppSessionLoss, undefined);
  await production.close();
  const manager = f.manager({ publish: false, expiryProbe: true });
  await assert.rejects(manager.simulateAppSessionLoss(), /requires-validated/);
  await manager.renew();
  const casCookies = [
    { name: "TGC", value: "SYNTHETIC_CAS_SECRET", domain: "app01.colsanitas.com", path: "/cas" },
    { name: "JSESSIONID", value: "SYNTHETIC_CAS_SESSION", domain: "app01.colsanitas.com", path: "/cas" },
  ];
  f.context().jar.push(...casCookies);
  assert.deepEqual(await manager.simulateAppSessionLoss(), { removedSessionCookies: 1 });
  assert.deepEqual(f.context().jar, casCookies);
  assert.equal(f.calls.push, 0);
  await manager.close();
});

test("explicit SSO-loss probe only clears auth cookies and preserves challenge state", async t => {
  const f = fixture(t);
  const manager = f.manager({ publish: false, expiryProbe: true });
  await manager.renew();
  const challengeCookie = { name: "__uzmc", value: "SYNTHETIC_CHALLENGE_STATE", domain: "app01.colsanitas.com", path: "/" };
  f.context().jar.push(
    { name: "CASTGC", value: "SYNTHETIC_CAS_SECRET", domain: "app01.colsanitas.com", path: "/cas" },
    { name: "JSESSIONID", value: "SYNTHETIC_CAS_SESSION", domain: "app01.colsanitas.com", path: "/cas" },
    challengeCookie,
  );
  assert.deepEqual(await manager.simulateAppSessionLoss({ includeSso: true }),
    { removedSessionCookies: 1, removedSsoCookies: 2 });
  assert.deepEqual(f.context().jar, [challengeCookie]);
  assert.equal(f.calls.push, 0);
  await manager.close();
});

test("probe report cannot retain an all-success result when a later test phase throws", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bukeala-probe-report-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "fixture.cjs");
  fs.writeFileSync(preload, `
    const modulePath = ${JSON.stringify(require.resolve("./persistentSession"))};
    require(modulePath);
    require.cache[modulePath].exports.createPersistentSessionManager = () => ({
      renew: async () => ({ ok: true, authenticated: true }),
      simulateAppSessionLoss: async () => { throw new Error("SYNTHETIC_SECRET"); },
      close: async () => {},
    });
  `);
  const child = require("node:child_process").spawnSync(process.execPath, [
    "--require", preload, path.join(__dirname, "persistentProbe.js"), "--simulate-app-expiry", "--restart",
  ], { env: { ...process.env, BROWSER_PROFILE_DIR: directory }, encoding: "utf8" });
  assert.equal(child.status, 1);
  const report = JSON.parse(fs.readFileSync(path.join(directory, "probe-result.json"), "utf8"));
  assert.equal(report.results[0].ok, true);
  assert.equal(report.results.at(-1).phase, "probe-error");
  assert.equal(report.results.at(-1).ok, false);
  assert.doesNotMatch(child.stdout + child.stderr + JSON.stringify(report), /SYNTHETIC_SECRET/);
});

test("a CAS URL without a visible form cannot submit credentials or consume a login attempt", async t => {
  const f = fixture(t, { startAuthenticated: false, loginFormMissing: true });
  const manager = f.manager();
  const result = await manager.renew();
  assert.equal(result.reasonCode, "login-form-unavailable");
  assert.equal(result.loginAttempted, false);
  assert.equal(f.calls.submit.length, 0);
  assert.equal(f.calls.push, 0);
  await manager.close();
});

test("failed login cooldown survives restart and suppresses repeated submissions", async t => {
  const f = fixture(t, { startAuthenticated: false, submitFailure: true });
  let manager = f.manager();
  const failed = await manager.renew();
  assert.equal(failed.loginAttempted, true);
  assert.equal(failed.ok, false);
  assert.equal(f.calls.submit.length, 1);
  await manager.close();
  manager = f.manager();
  const cooled = await manager.renew();
  assert.equal(cooled.reasonCode, "full-login-cooldown");
  assert.equal(cooled.loginAttempted, false);
  assert.equal(f.calls.submit.length, 1);
  assert.doesNotMatch(JSON.stringify({ failed, cooled, logs: f.calls.logs }), /SECRET|ticket=/);
  f.advance(30 * 60 * 1000 + 1);
  await manager.renew();
  assert.equal(f.calls.submit.length, 2);
  await manager.close();
});

test("isolated full-login probe verifies locally without publishing or worker checks", async t => {
  const f = fixture(t, { startAuthenticated: false });
  const manager = f.manager({ publish: false });
  const result = await manager.renew();
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.loginAttempted, true);
  assert.equal(result.published, false);
  assert.equal(result.captureAccepted, false);
  assert.equal(result.workerVerified, false);
  assert.equal(f.calls.submit.length, 1);
  assert.equal(f.calls.push, 0);
  assert.equal(f.calls.worker, 0);
  assert.equal(f.calls.addCookies, 0);
  await manager.close();
});

test("publication errors preserve the healthy browser and never trigger a fresh login", async t => {
  const f = fixture(t, { pushFailure: true });
  const manager = f.manager();
  const first = await manager.renew();
  assert.equal(first.authenticated, true);
  assert.equal(first.published, false);
  assert.equal(first.needsFullLogin, false);
  assert.equal(first.reasonCode, "publication-failed");
  assert.doesNotMatch(JSON.stringify(first), /SECRET|token=/);
  f.config.pushFailure = false;
  assert.equal((await manager.renew()).published, true);
  assert.equal(f.calls.submit.length, 0);
  assert.equal(f.calls.launch.length, 1);
  await manager.close();
});

test("inconclusive Worker verification does not claim published success", async t => {
  const f = fixture(t, { workerResult: { ok: false, inconclusive: true } });
  const manager = f.manager();
  const result = await manager.renew();
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, true);
  assert.equal(result.captureAccepted, true);
  assert.equal(result.published, false);
  assert.equal(result.reasonCode, "worker-verification-inconclusive");
  assert.equal(result.needsFullLogin, false);
  assert.equal(f.context().closed, false);
  await manager.close();
});

test("actual strict Worker verifier rejects ambiguous responses after its bounded retry", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("synthetic maintenance", { status: 503 });
  });
  const result = await sessionHelpers.verifyViaWorker(
    "https://example.invalid/capture", "SYNTHETIC_CAPTURE_SECRET", () => {}, { strict: true },
  );
  assert.equal(requests, 2);
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, true);
});

test("strict Worker verifier requires real components JSON instead of alive:true", async t => {
  const seenPaths = [];
  const logs = [];
  let body = JSON.stringify(COMPONENTS);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seenPaths.push(new URL(url).pathname);
    assert.equal(options.redirect, "manual");
    return new Response(body, { status: 200 });
  });
  const logger = (...args) => logs.push(args);
  const verified = await sessionHelpers.verifyViaWorker(
    "https://example.invalid/capture", "SYNTHETIC_CAPTURE_SECRET", logger, { strict: true },
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.componentCount, 1);
  assert.equal(verified.status, 200);
  for (const invalid of [
    "<html>Login SYNTHETIC_BODY_SECRET</html>",
    '{"alive":true}',
    '[{"id":1218,"code":"x"}]',
  ]) {
    body = invalid;
    const rejected = await sessionHelpers.verifyViaWorker(
      "https://example.invalid/capture", "SYNTHETIC_CAPTURE_SECRET", logger, { strict: true },
    );
    assert.equal(rejected.ok, false);
    assert.doesNotMatch(JSON.stringify(rejected), /SECRET|token=/);
  }
  assert.deepEqual(seenPaths, Array(4).fill("/debug/components"));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|token=|<html>/);
});

test("strict Worker verifier rejects 401 and 403 immediately without exposing response bodies", async t => {
  let status = 401;
  let requests = 0;
  const logs = [];
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("SYNTHETIC_BODY_SECRET", { status });
  });
  for (status of [401, 403]) {
    const result = await sessionHelpers.verifyViaWorker(
      "https://example.invalid/capture", "SYNTHETIC_CAPTURE_SECRET",
      (...args) => logs.push(args), { strict: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.detail, `worker-components-http-${status}`);
  }
  assert.equal(requests, 2);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|token=/);
});

test("strict Worker verifier sanitizes network exceptions and fails after one retry", async t => {
  let requests = 0;
  const logs = [];
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("https://example.invalid/debug/components?token=SYNTHETIC_CAPTURE_SECRET");
  });
  const result = await sessionHelpers.verifyViaWorker(
    "https://example.invalid/capture", "SYNTHETIC_CAPTURE_SECRET",
    (...args) => logs.push(args), { strict: true },
  );
  assert.equal(requests, 2);
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, true);
  assert.doesNotMatch(JSON.stringify({ result, logs }), /SECRET|token=/);
});

test("legacy Worker verifier retains the measure endpoint", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(new URL(url).pathname, "/debug/measure");
    return new Response(JSON.stringify({ alive: true, status: 200 }), { status: 200 });
  });
  const result = await sessionHelpers.verifyViaWorker(
    "https://example.invalid/capture", "SYNTHETIC_CAPTURE_SECRET", () => {},
  );
  assert.equal(result.ok, true);
});

test("unexpected authenticated endpoint bodies do not publish or submit credentials", async t => {
  for (const body of ["[malformed", '{"error":"session expired"}', "[]", '[{"code":"x"}]']) {
    const f = fixture(t, { responseBody: body });
    const manager = f.manager();
    const result = await manager.renew();
    assert.equal(result.authenticated, false);
    assert.equal(result.published, false);
    assert.equal(f.calls.submit.length, 0);
    assert.equal(f.calls.push, 0);
    await manager.close();
  }
  assert.equal(sessionHelpers.isComponentsResponse(COMPONENTS), true);
});

test("navigation network failure preserves the profile without requesting credentials", async t => {
  const f = fixture(t, { navigationFailure: true });
  const manager = f.manager();
  const result = await manager.renew();
  assert.equal(result.reasonCode, "navigation-failed");
  assert.equal(result.retryable, true);
  assert.equal(result.needsFullLogin, false);
  assert.equal(f.calls.submit.length, 0);
  assert.equal(f.calls.push, 0);
  assert.equal(f.context().closed, false);
  await manager.close();
});

test("Bukeala server errors do not initiate CAS login", async t => {
  const f = fixture(t, { responseStatus: 503 });
  const manager = f.manager();
  const result = await manager.renew();
  assert.equal(result.reasonCode, "browser-verification-failed");
  assert.equal(result.needsFullLogin, false);
  assert.equal(result.retryable, true);
  assert.equal(f.calls.submit.length, 0);
  assert.equal(f.calls.push, 0);
  await manager.close();
});

test("explicit bootstrap accepts a fresh snapshot only into an empty profile", async t => {
  const f = fixture(t, { startAuthenticated: false });
  const manager = f.manager();
  const stale = await manager.seedCookies([COOKIE], { capturedAt: new Date(f.now() - 31 * 60_000).toISOString() });
  assert.equal(stale.reasonCode, "seed-not-fresh");
  const seeded = await manager.seedCookies([COOKIE], { capturedAt: new Date(f.now()).toISOString() });
  assert.equal(seeded.seeded, true);
  const result = await manager.renew({ allowFullLogin: false });
  assert.equal(result.ok, true);
  assert.equal(result.via, "persistent-adopted");
  assert.equal(result.loginAttempted, false);
  assert.equal(f.calls.submit.length, 0);
  const replace = await manager.seedCookies([{ ...COOKIE, value: "STALE" }], { capturedAt: new Date(f.now()).toISOString() });
  assert.equal(replace.reasonCode, "profile-already-populated");
  assert.equal(f.calls.addCookies, 1);
  await manager.close();
});

test("browser closure is recoverable without removing the persistent profile", async t => {
  const f = fixture(t);
  const manager = f.manager();
  await manager.renew();
  await f.context().close();
  assert.equal((await manager.renew()).authenticated, true);
  assert.equal(f.calls.launch.length, 2);
  assert.equal(f.calls.submit.length, 0);
  await manager.close();
});

test("diagnostic locations omit query, fragment, userinfo and unknown paths", () => {
  assert.equal(safeLocation(CAS), "https://app01.colsanitas.com/cas/login");
  assert.equal(safeLocation("https://user:password@example.invalid/SECRET_PATH?token=SECRET#SECRET"), "https://example.invalid/[redacted]");
});
