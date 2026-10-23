/**
 * One persistent Chromium profile, including CAS/browser state across restarts.
 * No legacy cookie import, profile reset, UA override, or stealth plugin.
 *
 * Full login requires ENABLE_FULL_LOGIN=1. A failed attempt has a durable
 * cooldown (at least 30 minutes), including after process restarts.
 * publish:false verifies in the browser without writing to the Worker.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { sessionHelpers } = require("./autoLogin");

const CAS_ENTRY = "https://app01.colsanitas.com/cas/login?service=" +
  encodeURIComponent("https://appoint.tuscitasmedicas.com/keraltyadscritos/cas/login");
const MIN_LOGIN_COOLDOWN_MS = 30 * 60 * 1000;
const SAFE_PATHS = new Set(["/", "/cas/login", "/authentication/login",
  "/keraltyadscritos/cas/login", "/keraltyadscritos/findAvailability"]);

function safeLocation(value) {
  try {
    const url = new URL(value);
    return url.origin + (SAFE_PATHS.has(url.pathname) ? url.pathname : "/[redacted]");
  } catch { return null; }
}

function isCasFormLocation(value) {
  try {
    const url = new URL(value);
    return url.hostname === "app01.colsanitas.com" && url.pathname === "/cas/login";
  } catch { return false; }
}

function isAuthChallenge(value) {
  try {
    const host = new URL(value).hostname;
    return host !== "appoint.tuscitasmedicas.com" && host !== "app01.colsanitas.com";
  } catch { return true; }
}

function relevantDomain(value) {
  const domain = String(value || "").toLowerCase().replace(/^\./, "");
  return domain === "tuscitasmedicas.com" || domain.endsWith(".tuscitasmedicas.com") ||
    domain === "colsanitas.com" || domain.endsWith(".colsanitas.com");
}

function prepareProfile(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-profile-directory");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function createPersistentSessionManager(env, options = {}) {
  const profileDir = path.resolve(env.BROWSER_PROFILE_DIR || path.join(os.homedir(), ".bukeala-browser"));
  const stateFile = path.join(profileDir, "session-keeper.json");
  const publish = options.publish !== false;
  const helpers = { ...sessionHelpers, ...options.helpers };
  const now = options.now || Date.now;
  const configuredCooldown = Number(env.FULL_LOGIN_COOLDOWN_MS);
  const cooldownMs = Number.isFinite(configuredCooldown)
    ? Math.max(MIN_LOGIN_COOLDOWN_MS, configuredCooldown) : MIN_LOGIN_COOLDOWN_MS;
  let context = null;
  let page = null;
  let inFlight = false;
  let closed = false;
  let seeded = false;
  let state;

  // Messages/metadata from legacy helpers may contain full URLs or server
  // bodies. Forward only fixed messages and numeric diagnostics.
  function log(level, event, metadata = {}) {
    if (typeof env.log !== "function") return;
    const safe = {};
    for (const key of ["status", "elapsedMs", "cookieCount", "count"]) {
      if (typeof metadata[key] === "number") safe[key] = metadata[key];
    }
    env.log(level, event, safe);
  }
  function helperLog(level, _message, metadata) {
    log(level, "persistent-session helper diagnostic", metadata);
  }

  function readState() {
    if (state) return state;
    prepareProfile(profileDir);
    if (!fs.existsSync(stateFile)) return (state = {});
    if (fs.lstatSync(stateFile).isSymbolicLink()) throw new Error("unsafe-profile-state");
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-profile-state");
    for (const key of ["lastFullLoginAttemptAt", "lastFullLoginSuccessAt", "seededAt"]) {
      if (parsed[key] !== undefined && (!Number.isFinite(parsed[key]) || parsed[key] < 0)) {
        throw new Error("invalid-profile-state");
      }
    }
    return (state = parsed);
  }

  function saveState() {
    prepareProfile(profileDir);
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, stateFile);
  }

  async function ensureContext() {
    if (closed) throw new Error("manager-closed");
    readState();
    if (context) {
      if (!page || page.isClosed()) page = await context.newPage();
      return;
    }
    const chromium = options.chromium || require("playwright").chromium;
    const headless = options.headless === undefined ? env.BROWSER_HEADLESS !== "0" : options.headless !== false;
    const launched = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: headless ? { width: 1366, height: 800 } : null,
      locale: "es-CO",
      timezoneId: "America/Bogota",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--restore-last-session",
        ...(!headless ? ["--start-maximized"] : [])],
      timeout: 60_000,
    });
    context = launched;
    context.on("close", () => {
      if (context === launched) { context = null; page = null; }
    });
    page = context.pages().find(candidate => !candidate.isClosed()) || await context.newPage();
    log("info", "persistent browser profile opened");
  }

  function result(overrides = {}) {
    return {
      ok: false, via: seeded ? "persistent-adopted" : "persistent",
      authenticated: false, published: false, captureAccepted: false,
      workerVerified: false, loginAttempted: false, needsFullLogin: false,
      retryable: false, authBlocked: false,
      postNavUrl: page && !page.isClosed() ? safeLocation(page.url()) : null,
      ...overrides,
    };
  }

  async function navigate(target) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
  }

  async function renew(renewOptions = {}) {
    if (inFlight) return result({ reasonCode: "busy", reason: "persistent-operation-in-progress", retryable: true });
    inFlight = true;
    let authenticated = false;
    let loginAttempted = false;
    let captureAccepted = false;
    let stage = "profile";
    try {
      await ensureContext();
      stage = "navigation";
      await navigate(helpers.BUKEALA_HOME);
      if (isAuthChallenge(page.url())) {
        return result({ reasonCode: "auth-challenge", reason: "authentication-challenge", authBlocked: true });
      }

      stage = "verification";
      let verification = isCasFormLocation(page.url()) ? { ok: false, authRequired: true }
        : await helpers.verifySessionWorks(context, helperLog, { strict: true });
      // Only an explicit authentication rejection can initiate CAS renewal.
      // A timeout, invalid JSON or server error preserves the current context.
      if (!verification.ok && verification.authRequired && !isCasFormLocation(page.url())) {
        stage = "navigation";
        await navigate(CAS_ENTRY);
        if (isAuthChallenge(page.url())) {
          return result({ reasonCode: "auth-challenge", reason: "authentication-challenge", authBlocked: true });
        }
        stage = "verification";
        verification = isCasFormLocation(page.url()) ? { ok: false, authRequired: true }
          : await helpers.verifySessionWorks(context, helperLog, { strict: true });
      }

      if (!verification.ok && isCasFormLocation(page.url())) {
        const visibleForm = await Promise.all([
          page.locator('input[name="username"], input#username').first().waitFor({ state: "visible", timeout: 10000 }),
          page.locator('input[name="password"], input#password').first().waitFor({ state: "visible", timeout: 10000 }),
        ]).then(() => true, () => false);
        if (!visibleForm) {
          return result({ reasonCode: "login-form-unavailable", reason: "login-form-unavailable", authBlocked: true });
        }
        if (env.ENABLE_FULL_LOGIN !== "1" || renewOptions.allowFullLogin === false) {
          return result({ reasonCode: "full-login-disabled", reason: "full-login-disabled", needsFullLogin: true });
        }
        if (!env.CAS_USERNAME || !env.CAS_PASSWORD || !env.TWO_CAPTCHA_API_KEY) {
          return result({ reasonCode: "login-config-missing", reason: "login-config-missing", needsFullLogin: true });
        }
        const lastAttempt = state.lastFullLoginAttemptAt || 0;
        const lastSuccess = state.lastFullLoginSuccessAt || 0;
        if (lastAttempt > lastSuccess && now() - lastAttempt < cooldownMs) {
          return result({
            reasonCode: "full-login-cooldown", reason: "full-login-cooldown",
            needsFullLogin: true, retryable: true,
            nextLoginAt: new Date(lastAttempt + cooldownMs).toISOString(),
          });
        }
        // Persist before submission, so a crash cannot reset the attempt limit.
        state.lastFullLoginAttemptAt = now();
        state.lastFullLoginSuccessAt = 0;
        saveState();
        loginAttempted = true;
        stage = "full-login";
        await helpers.submitCasForm(page, {
          username: env.CAS_USERNAME, password: env.CAS_PASSWORD,
        }, env.TWO_CAPTCHA_API_KEY, helperLog);
        if (isAuthChallenge(page.url()) || isCasFormLocation(page.url())) {
          return result({
            via: "persistent-login", loginAttempted, needsFullLogin: true,
            reasonCode: "full-login-rejected", reason: "full-login-rejected", authBlocked: true,
          });
        }
        stage = "verification";
        verification = await helpers.verifySessionWorks(context, helperLog, { strict: true });
      }

      if (!verification.ok || !(await helpers.hasBukealaSession(context))) {
        return result({
          loginAttempted, via: loginAttempted ? "persistent-login" : result().via,
          reasonCode: "browser-verification-failed", reason: "browser-verification-failed",
          needsFullLogin: !!verification.authRequired, retryable: !verification.authRequired,
        });
      }
      authenticated = true;
      state.validated = true;
      if (loginAttempted) state.lastFullLoginSuccessAt = now();
      saveState();
      const via = loginAttempted ? "persistent-login" : result().via;
      if (!publish) {
        const cookieCount = (await context.cookies()).filter(cookie => relevantDomain(cookie.domain)).length;
        return result({ ok: true, via, authenticated, loginAttempted, cookieCount });
      }
      if (!env.WORKER_URL || !env.CAPTURE_TOKEN) {
        return result({ via, authenticated, loginAttempted, reasonCode: "publish-config-missing", reason: "publish-config-missing" });
      }
      stage = "publication";
      const cookieCount = await helpers.captureAndPush(context, env.WORKER_URL, env.CAPTURE_TOKEN, helperLog);
      captureAccepted = true;
      const worker = await helpers.verifyViaWorker(env.WORKER_URL, env.CAPTURE_TOKEN, helperLog, { strict: true });
      if (!worker.ok) {
        return result({
          via, authenticated, loginAttempted, captureAccepted, cookieCount, retryable: true,
          reasonCode: worker.inconclusive ? "worker-verification-inconclusive" : "worker-verification-failed",
          reason: worker.inconclusive ? "worker-verification-inconclusive" : "worker-verification-failed",
        });
      }
      return result({
        ok: true, via, authenticated, loginAttempted, captureAccepted,
        published: true, workerVerified: true, cookieCount,
      });
    } catch (error) {
      // Do not return browser errors: they can embed login URLs, submitted
      // credential values, cookies, or server bodies. Fixed codes suffice.
      const reasonCode = `${stage}-failed`;
      log("warn", "persistent session operation failed");
      return result({
        authenticated, loginAttempted, captureAccepted,
        via: loginAttempted ? "persistent-login" : result().via,
        reasonCode, reason: reasonCode, retryable: stage !== "full-login",
        needsFullLogin: stage === "full-login", authBlocked: stage === "full-login",
      });
    } finally {
      inFlight = false;
    }
  }

  /**
   * Explicit one-time migration only. Never called by renew(). Refuses to
   * overwrite any existing relevant cookies or a previously validated profile.
   * Caller must obtain an authorized fresh snapshot and then call renew().
   */
  async function seedCookies(cookies, { capturedAt } = {}) {
    if (inFlight) return result({ reasonCode: "busy", reason: "persistent-operation-in-progress" });
    inFlight = true;
    try {
      await ensureContext();
      const timestamp = Date.parse(capturedAt);
      if (!Number.isFinite(timestamp) || timestamp > now() + 60_000 || now() - timestamp > 30 * 60_000) {
        return result({ reasonCode: "seed-not-fresh", reason: "seed-not-fresh" });
      }
      if (state.validated || state.seededAt || (await context.cookies()).some(cookie => relevantDomain(cookie.domain))) {
        return result({ reasonCode: "profile-already-populated", reason: "profile-already-populated" });
      }
      if (!Array.isArray(cookies) || !cookies.length) return result({ reasonCode: "seed-empty", reason: "seed-empty" });
      const filtered = cookies.filter(cookie =>
        cookie && relevantDomain(cookie.domain) && typeof cookie.name === "string" &&
        typeof cookie.value === "string" && cookie.value.length > 0 &&
        (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now() / 1000) &&
        !(cookie.name === "JSESSIONID" && !String(cookie.domain).includes("tuscitasmedicas.com"))
      ).map(cookie => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain,
        path: cookie.path || "/", httpOnly: !!cookie.httpOnly, secure: cookie.secure !== false,
        ...(typeof cookie.expires === "number" && cookie.expires > 0 ? { expires: cookie.expires } : {}),
        ...(["Strict", "Lax", "None"].includes(cookie.sameSite) ? { sameSite: cookie.sameSite } : {}),
      }));
      if (!filtered.some(cookie => cookie.name === "JSESSIONID")) {
        return result({ reasonCode: "seed-no-bukeala-session", reason: "seed-no-bukeala-session" });
      }
      state.seededAt = timestamp;
      saveState();
      await context.addCookies(filtered);
      seeded = true;
      return result({ ok: true, seeded: true, cookieCount: filtered.length });
    } catch {
      return result({ reasonCode: "seed-failed", reason: "seed-failed" });
    } finally { inFlight = false; }
  }

  async function close() {
    if (inFlight) throw new Error("persistent-operation-in-progress");
    closed = true;
    const active = context;
    context = null;
    page = null;
    if (active) await active.close();
  }

  // Available only to the explicit, non-publishing probe. This simulates
  // losing local auth cookies; it never logs out CAS/server-side.
  async function simulateAppSessionLoss({ includeSso = false } = {}) {
    if (publish || options.expiryProbe !== true) throw new Error("probe-only-operation");
    if (inFlight) throw new Error("persistent-operation-in-progress");
    inFlight = true;
    try {
      await ensureContext();
      if (!state.validated) throw new Error("probe-requires-validated-session");
      const cookies = await context.cookies();
      const sessions = cookies.filter(cookie => cookie.name === "JSESSIONID" &&
        /(^|\.)tuscitasmedicas\.com$/i.test(cookie.domain.replace(/^\./, "")));
      if (!sessions.length) throw new Error("probe-session-missing");
      const sso = includeSso ? cookies.filter(cookie =>
        /(^|\.)colsanitas\.com$/i.test(cookie.domain.replace(/^\./, "")) &&
        (cookie.name === "JSESSIONID" || /^(?:TGC|CASTGC)/i.test(cookie.name))) : [];
      if (includeSso && !sso.some(cookie => /^(?:TGC|CASTGC)/i.test(cookie.name))) {
        throw new Error("probe-sso-session-missing");
      }
      for (const cookie of [...sessions, ...sso]) {
        await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
      }
      return { removedSessionCookies: sessions.length, ...(includeSso ? { removedSsoCookies: sso.length } : {}) };
    } finally { inFlight = false; }
  }

  return {
    renew, seedCookies, close, profileDir,
    ...(!publish && options.expiryProbe === true ? { simulateAppSessionLoss } : {}),
  };
}

module.exports = { createPersistentSessionManager, safeLocation };
