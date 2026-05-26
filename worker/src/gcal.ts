/**
 * Google Calendar client — Service Account authentication.
 *
 * Usa una cuenta de servicio (no OAuth de usuario). El JSON de la cuenta
 * de servicio se guarda en el secret GCAL_SERVICE_ACCOUNT_JSON.
 *
 * Flujo de auth:
 *   1. Firmar JWT con RS256 (private key del service account)
 *   2. Cambiar JWT por access_token en https://oauth2.googleapis.com/token
 *   3. Cachear access_token en KV (50 min, el token dura 1h)
 *   4. Usar token con calls a la API de Calendar
 *
 * El calendario debe ser COMPARTIDO con el email del service account
 * (xxx@xxx.iam.gserviceaccount.com) con permiso "Hacer cambios en eventos".
 */
import type { Env } from "./env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TOKEN_CACHE_KEY = "gcal:access_token";
const TOKEN_TTL = 60 * 50; // 50 min (token dura 1h)

interface ServiceAccountJSON {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface GCalEvent {
  id?: string;
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: { email: string; displayName?: string }[];
  reminders?: { useDefault: boolean };
  // Campos solo de lectura (vienen del API):
  recurringEventId?: string;  // si está presente, es instancia de evento recurrente
  status?: string;            // "confirmed", "cancelled", etc.
  location?: string;
}

export interface BusyPeriod {
  start: string; // ISO
  end: string;   // ISO
}

// ============================================================
// JWT signing con Web Crypto API
// ============================================================

function base64UrlEncode(input: string | ArrayBuffer): string {
  let str: string;
  if (typeof input === "string") {
    str = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    str = btoa(binary);
  }
  return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\\n/g, "")  // strip escaped newlines (puede venir así si pasan por env)
    .replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signJWT(claims: object, privateKey: CryptoKey): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const signatureInput = `${headerB64}.${claimsB64}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signatureInput),
  );
  const signatureB64 = base64UrlEncode(signature);
  return `${signatureInput}.${signatureB64}`;
}

// ============================================================
// Token management
// ============================================================

function parseServiceAccount(env: Env): ServiceAccountJSON {
  const raw = (env as any).GCAL_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GCAL_SERVICE_ACCOUNT_JSON no configurado");
  try {
    const obj = JSON.parse(raw);
    if (!obj.client_email || !obj.private_key) {
      throw new Error("Service account JSON inválido (falta client_email o private_key)");
    }
    return obj;
  } catch (e) {
    throw new Error(`No se pudo parsear GCAL_SERVICE_ACCOUNT_JSON: ${(e as Error).message}`);
  }
}

async function getAccessToken(env: Env): Promise<string> {
  // Intenta cache primero
  const cached = await env.STATE.get(TOKEN_CACHE_KEY);
  if (cached) {
    try {
      const obj: CachedToken = JSON.parse(cached);
      if (obj.expiresAt > Date.now() + 60_000) {
        return obj.token;
      }
    } catch { /* fall through */ }
  }

  const sa = parseServiceAccount(env);
  const privateKey = await importPrivateKey(sa.private_key);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: sa.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const jwt = await signJWT(claims, privateKey);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GCal token exchange failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json<{ access_token: string; expires_in: number }>();
  const cacheObj: CachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  await env.STATE.put(TOKEN_CACHE_KEY, JSON.stringify(cacheObj), { expirationTtl: TOKEN_TTL });
  return data.access_token;
}

// ============================================================
// API calls
// ============================================================

async function gcalFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(env);
  const url = path.startsWith("http") ? path : `${CALENDAR_API}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Consulta FreeBusy para un calendario en un rango.
 * Retorna lista de periodos ocupados (busy).
 */
export async function getFreeBusy(
  env: Env,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<BusyPeriod[]> {
  const res = await gcalFetch(env, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: "America/Bogota",
      items: [{ id: calendarId }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`FreeBusy failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json<any>();
  return data.calendars?.[calendarId]?.busy || [];
}

/**
 * Crea un evento en el calendario.
 */
export async function createEvent(
  env: Env,
  calendarId: string,
  event: GCalEvent,
): Promise<GCalEvent> {
  const res = await gcalFetch(env, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Create event failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Lista eventos de un calendario en un rango.
 */
export async function listEvents(
  env: Env,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<GCalEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    timeZone: "America/Bogota",
  });
  const res = await gcalFetch(
    env,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`List events failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json<any>();
  return data.items || [];
}

/**
 * Devuelve el email del service account (útil para diagnóstico).
 */
export function getServiceAccountEmail(env: Env): string {
  try {
    return parseServiceAccount(env).client_email;
  } catch {
    return "(no configurado)";
  }
}
