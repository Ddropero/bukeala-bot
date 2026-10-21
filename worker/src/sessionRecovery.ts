import type { Env } from "./env";
import { getDoctorRecipients } from "./users";

const REQUEST_KEY = "nativeHost:refreshRequest";
const REQUEST_TTL = 7 * 24 * 60 * 60;
const GRACE_MS = 6 * 60 * 1000;
const PICKUP_LEASE_MS = 5 * 60 * 1000;
const numericChat = (value: unknown): value is string => typeof value === "string" && /^-?\d+$/.test(value);

export interface RefreshRequest {
  version?: 2;
  requestedAt: string;
  requestedBy: string;
  source?: string;
  notifyChatIds?: string[];
  pickedUpAt?: string;
  nextAttemptAt?: number;
  attempts?: number;
  noticeSentAt?: string;
  failureNoticeAt?: string;
  humanNoticeAt?: string;
  successDeliveredChatIds?: string[];
  successTerminalChatIds?: string[];
  lastResult?: { ok: false; at: string; reasonCode?: string };
}

export interface RefreshCompletion {
  requestedAt?: string;
  ok?: boolean;
  message?: string;
  reasonCode?: string;
  completedAt?: string;
  nextAttemptAt?: number | string;
}

async function readRequest(env: Env): Promise<RefreshRequest | null> {
  // An unavailable KV read is not an absent request. Let it fail the HTTP
  // callback so the watcher's durable outbox retries instead of discarding it.
  const raw = await env.STATE.get(REQUEST_KEY);
  if (!raw) return null;
  try {
    const value: RefreshRequest = JSON.parse(raw);
    return value && typeof value.requestedAt === "string" && Number.isFinite(Date.parse(value.requestedAt)) &&
      typeof value.requestedBy === "string" ? value : null;
  } catch { return null; }
}

async function saveRequest(env: Env, request: RefreshRequest): Promise<void> {
  await env.STATE.put(REQUEST_KEY, JSON.stringify(request), { expirationTtl: REQUEST_TTL });
}

function manualRecipients(request: RefreshRequest): string[] {
  return [...new Set([
    ...(Array.isArray(request.notifyChatIds) ? request.notifyChatIds.filter(numericChat) : []),
    ...(numericChat(request.requestedBy) ? [request.requestedBy] : []),
  ])];
}

/** The source is diagnostic data; only numeric chat IDs are Telegram recipients. */
export async function requestRecovery(env: Env, requestedBy: string, now = Date.now()): Promise<void> {
  const current = await readRequest(env);
  const manual = numericChat(requestedBy);
  if (current) {
    // Cron never replaces an in-flight manual request or resets its retry deadline.
    if (!manual || manualRecipients(current).includes(requestedBy)) return;
    current.notifyChatIds = [...manualRecipients(current), requestedBy];
    if (!numericChat(current.requestedBy)) current.requestedBy = requestedBy;
    await saveRequest(env, current);
    return;
  }
  await saveRequest(env, {
    version: 2,
    requestedAt: new Date(now).toISOString(),
    requestedBy,
    source: manual ? "telegram" : requestedBy,
    notifyChatIds: manual ? [requestedBy] : [],
    attempts: 0,
  });
}

export async function pollRecovery(env: Env, now = Date.now()) {
  const request = await readRequest(env);
  if (!request) return { pending: false };
  if (request.nextAttemptAt && request.nextAttemptAt > now) {
    return { pending: false, retryAfterMs: request.nextAttemptAt - now, nextAttemptAt: request.nextAttemptAt };
  }
  if (request.pickedUpAt && now - Date.parse(request.pickedUpAt) < PICKUP_LEASE_MS) {
    return { pending: false, alreadyPickedUp: true };
  }
  request.pickedUpAt = new Date(now).toISOString();
  await saveRequest(env, request);
  return {
    pending: true,
    requestedAt: request.requestedAt,
    requestedBy: request.requestedBy,
    source: request.source ?? (numericChat(request.requestedBy) ? "telegram" : request.requestedBy),
    nextAttemptAt: request.nextAttemptAt,
  };
}

async function notifyRecipients(env: Env, recipients: string[], text: string) {
  const delivered: string[] = [];
  const terminal: string[] = [];
  let temporaryFailure = false;
  for (const chatId of [...new Set(recipients.filter(numericChat))]) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json() as { ok?: boolean; error_code?: number };
      if (response.ok && body.ok === true) delivered.push(chatId);
      else if ([400, 403].includes(response.status) || [400, 403].includes(body.error_code ?? 0)) terminal.push(chatId);
      else temporaryFailure = true;
    } catch { temporaryFailure = true; }
  }
  if (temporaryFailure) console.log("[session-recovery] Telegram notification temporarily unavailable");
  if (terminal.length) console.log("[session-recovery] Telegram rejected recipient permanently", { count: terminal.length });
  return { delivered, terminal, temporaryFailure };
}

async function notify(env: Env, recipients: string[], text: string): Promise<boolean> {
  return !(await notifyRecipients(env, recipients, text)).temporaryFailure;
}

function needsHumanAttention(reasonCode?: string): boolean {
  return /challenge|captcha|blocked|credential|login-form-unavailable|full-login-rejected/i.test(reasonCode ?? "");
}

/** Read-only status for /estado; never picks up a request or changes its retry deadline. */
export async function getRecoveryStatus(env: Env, now = Date.now()) {
  const request = await readRequest(env);
  if (!request) return { pending: false as const };
  const pickedUpAt = Date.parse(request.pickedUpAt ?? "");
  return {
    pending: true as const,
    requestedAt: request.requestedAt,
    nextAttemptAt: typeof request.nextAttemptAt === "number" && Number.isFinite(request.nextAttemptAt)
      ? request.nextAttemptAt : undefined,
    pickedUp: Number.isFinite(pickedUpAt) && pickedUpAt <= now && now - pickedUpAt < PICKUP_LEASE_MS,
    // A later network failure/cooldown does not prove that the earlier human
    // challenge was cleared. Keep that warning until this request succeeds.
    needsHumanAttention: Boolean(request.humanNoticeAt) || needsHumanAttention(request.lastResult?.reasonCode),
  };
}

async function addHumanNotice(env: Env, request: RefreshRequest, now: number): Promise<boolean> {
  if (request.humanNoticeAt || !needsHumanAttention(request.lastResult?.reasonCode)) return false;
  const delivered = await notify(env, [...manualRecipients(request), ...await getDoctorRecipients(env)],
    "⚠️ <b>Bukeala requiere atención para recuperar el acceso</b>\n\nEl proveedor puede estar pidiendo una verificación humana o revisar el acceso en el navegador de la VM. El servicio conserva la solicitud y respetará la espera entre reintentos. Repetir /sesion_renew no elimina esa verificación.");
  if (delivered) {
    request.humanNoticeAt = new Date(now).toISOString();
    request.failureNoticeAt = request.humanNoticeAt;
    request.noticeSentAt = request.humanNoticeAt;
  }
  return delivered;
}

/** Silent grace period: a transient failure followed by a healthy VM needs no manual action. */
async function addDelayNotice(env: Env, request: RefreshRequest, now: number): Promise<boolean> {
  // A callback may have been acknowledged before this reason was recognized,
  // or its notification may have failed. Cron can escalate the stored outcome
  // without creating another login attempt or changing its retry deadline.
  if (needsHumanAttention(request.lastResult?.reasonCode)) return addHumanNotice(env, request, now);
  if (request.noticeSentAt || now - Date.parse(request.requestedAt) < GRACE_MS) return false;
  const delivered = await notify(env, await getDoctorRecipients(env),
    "⚠️ <b>Bukeala sigue sin estar disponible</b>\n\n" +
    "La VM está intentando recuperar la sesión automáticamente y continuará con sus reintentos. " +
    "Puedes dejar el computador apagado; no necesitas enviar /sesion_renew.\n\n" +
    "Te avisaré cuando se recupere o si el proveedor exige una verificación humana. Puedes consultar /estado.");
  if (delivered) {
    request.noticeSentAt = new Date(now).toISOString();
  }
  return delivered;
}

export async function notifyRecoveryDelay(env: Env, now = Date.now()): Promise<void> {
  const request = await readRequest(env);
  if (!request) return;
  if (await addDelayNotice(env, request, now)) {
    const latest = await readRequest(env);
    if (latest?.requestedAt === request.requestedAt) {
      latest.noticeSentAt = request.noticeSentAt;
      latest.humanNoticeAt = request.humanNoticeAt ?? latest.humanNoticeAt;
      latest.failureNoticeAt = request.failureNoticeAt ?? latest.failureNoticeAt;
      await saveRequest(env, latest);
    }
  }
}

function nextRetry(body: RefreshCompletion, attempts: number, now: number): number {
  const supplied = typeof body.nextAttemptAt === "number" ? body.nextAttemptAt : Date.parse(body.nextAttemptAt ?? "");
  if (Number.isFinite(supplied) && supplied > now) return Math.min(supplied, now + 60 * 60 * 1000);
  const loginBlocked = /captcha|blocked|credential|login|cooldown|challenge|config/i.test(body.reasonCode ?? "");
  return now + (loginBlocked ? Math.min(3600000, 1800000 * attempts) : Math.min(600000, 90000 * attempts));
}

/**
 * Correlation prevents an old watcher result from completing a newer request.
 * KV remains eventually consistent: these checks are not a distributed lock.
 */
export async function completeRecovery(env: Env, body: RefreshCompletion, now = Date.now()) {
  const request = await readRequest(env);
  if (!request) return { ok: true, accepted: false, reason: "no_pending_request" };
  if ((!body.requestedAt && request.version === 2) ||
      (body.requestedAt && body.requestedAt !== request.requestedAt)) {
    return { ok: true, accepted: false, reason: body.requestedAt ? "stale" : "uncorrelated" };
  }
  if (body.ok !== true) {
    const completedAt = typeof body.completedAt === "string" && Number.isFinite(Date.parse(body.completedAt))
      ? body.completedAt : new Date(now).toISOString();
    // Retrying the watcher's durable outbox must not count as another login
    // attempt or extend the deadline that was already accepted.
    if (body.completedAt && request.lastResult?.at === completedAt) {
      return { ok: true, accepted: true, pending: true, nextAttemptAt: request.nextAttemptAt };
    }
    request.attempts = (request.attempts ?? 0) + 1;
    request.nextAttemptAt = nextRetry(body, request.attempts, now);
    request.lastResult = { ok: false, at: completedAt, reasonCode: body.reasonCode?.slice(0, 80) };
    delete request.pickedUpAt;
    const manual = manualRecipients(request);
    if (!needsHumanAttention(body.reasonCode) && !request.failureNoticeAt && manual.length) {
      if (await notify(env, manual,
        "⏳ <b>La recuperación sigue pendiente</b>\n\nLa VM volverá a intentarlo automáticamente después de la espera. No necesitas repetir /sesion_renew. Te avisaré cuando la sesión esté disponible.")) {
        request.failureNoticeAt = new Date(now).toISOString();
      }
    }
    await addDelayNotice(env, request, now);
    const latest = await readRequest(env);
    if (latest?.requestedAt !== request.requestedAt) return { ok: true, accepted: false, reason: "stale" };
    request.notifyChatIds = [...new Set([...manualRecipients(request), ...manualRecipients(latest)])];
    if (numericChat(latest.requestedBy)) request.requestedBy = latest.requestedBy;
    request.noticeSentAt ??= latest.noticeSentAt;
    request.humanNoticeAt ??= latest.humanNoticeAt;
    // One write per completion, including notification metadata (KV per-key rate limit).
    await saveRequest(env, request);
    return { ok: true, accepted: true, pending: true, nextAttemptAt: request.nextAttemptAt };
  }

  const legacyNotice = await env.STATE.get("keepalive:notified");
  const doctors = request.noticeSentAt || legacyNotice ? await getDoctorRecipients(env) : [];
  const recipients = [...new Set([...manualRecipients(request), ...doctors].filter(numericChat))];
  const deliveredIds = new Set(request.successDeliveredChatIds ?? []);
  const terminalIds = new Set(request.successTerminalChatIds ?? []);
  const pendingRecipients = recipients.filter((id) => !deliveredIds.has(id) && !terminalIds.has(id));
  if (pendingRecipients.length) {
    const sent = await notifyRecipients(env, pendingRecipients,
      "✅ <b>Sesión Bukeala recuperada</b>\n\nLa VM confirmó el acceso del bot. Ya puedes consultar las agendas; la renovación seguirá funcionando automáticamente.");
    for (const id of sent.delivered) deliveredIds.add(id);
    for (const id of sent.terminal) terminalIds.add(id);
  }
  // Re-read after network I/O: a callback must never deliberately delete another request.
  const latest = await readRequest(env);
  if (latest?.requestedAt !== request.requestedAt) return { ok: true, accepted: false, reason: "stale" };
  for (const id of latest.successDeliveredChatIds ?? []) deliveredIds.add(id);
  for (const id of latest.successTerminalChatIds ?? []) terminalIds.add(id);
  const latestDoctors = latest.noticeSentAt && !doctors.length ? await getDoctorRecipients(env) : doctors;
  const latestRecipients = [...new Set([...manualRecipients(latest), ...latestDoctors].filter(numericChat))];
  const stillPending = latestRecipients.some((id) => !deliveredIds.has(id) && !terminalIds.has(id));
  if (stillPending) {
    // Persist each recipient's result so retrying B does not spam A. A new
    // subscriber arriving during send also gets the eventual completion.
    latest.successDeliveredChatIds = [...deliveredIds];
    latest.successTerminalChatIds = [...terminalIds];
    await saveRequest(env, latest);
    return { ok: false, accepted: true, retryNotification: true };
  }
  await env.STATE.delete(REQUEST_KEY);
  await env.STATE.delete("keepalive:notified");
  await env.STATE.delete("keepalive:notifiedAt");
  return { ok: true, accepted: true, pending: false, recovered: true };
}

/** A verified healthy ping can close an automatic incident even if its callback was lost. */
export async function closeAutomaticRecovery(env: Env, now = Date.now()): Promise<void> {
  const request = await readRequest(env);
  if (!request || manualRecipients(request).length) return;
  await completeRecovery(env, { requestedAt: request.requestedAt, ok: true }, now);
}

export async function validComponentsResponse(response: Response): Promise<boolean> {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("json")) return false;
  try {
    const body: unknown = await response.json();
    return Array.isArray(body) && body.length > 0 && body.every((row) =>
      row && typeof row === "object" && !Array.isArray(row) && Number.isFinite(row.id) &&
      typeof row.code === "string" && row.code.trim().length > 0 && typeof row.description === "string");
  } catch { return false; }
}
