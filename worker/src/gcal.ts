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
  reminders?: { useDefault: boolean; overrides?: { method: "popup" | "email"; minutes: number }[] };
  /**
   * Propiedades que el usuario no ve en la UI de Calendar. `private` es visible
   * solo para la cuenta que las escribió (nuestro service account): ahí guarda
   * el espejo de Bukeala el id de la cita y su huella, y por ahí se buscan
   * (`privateExtendedProperty=clave=valor` en events.list).
   */
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  /** "opaque" (ocupa, cuenta en freeBusy) | "transparent" (libre). */
  transparency?: "opaque" | "transparent";
  colorId?: string;
  // Campos solo de lectura (vienen del API):
  recurringEventId?: string;  // si está presente, es instancia de evento recurrente
  status?: string;            // "confirmed", "cancelled", etc.
  location?: string;
  updated?: string;           // ISO de la última modificación (la haga quien la haga)
  htmlLink?: string;
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
 * Lista eventos con filtros finos y PAGINACIÓN completa. Es lo que usa el
 * espejo de Bukeala: busca por propiedad privada (`privateExtendedProperty`)
 * y, con `showDeleted`, también los eventos ya cancelados — necesario para
 * restaurar uno en vez de duplicarlo si la cita vuelve a estar activa.
 *
 * `listEvents` de arriba se deja intacta (la usan popCuc y la fuente gcal).
 */
export interface ListEventsOpts {
  timeMin?: string;
  timeMax?: string;
  /** Cada par se manda como `privateExtendedProperty=clave=valor` (AND entre ellos). */
  privateProps?: Record<string, string>;
  showDeleted?: boolean;
}

export async function listEventsFiltrado(
  env: Env,
  calendarId: string,
  opts: ListEventsOpts = {},
): Promise<GCalEvent[]> {
  const items: GCalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      maxResults: "2500",
      timeZone: "America/Bogota",
    });
    if (opts.timeMin) params.set("timeMin", opts.timeMin);
    if (opts.timeMax) params.set("timeMax", opts.timeMax);
    if (opts.showDeleted) params.set("showDeleted", "true");
    for (const [k, v] of Object.entries(opts.privateProps ?? {})) {
      params.append("privateExtendedProperty", `${k}=${v}`);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const res = await gcalFetch(
      env,
      `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`List events (filtrado) failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const data = await res.json<any>();
    items.push(...((data.items ?? []) as GCalEvent[]));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return items;
}

/**
 * Modifica SOLO los campos enviados (semántica PATCH). Por eso el espejo la
 * prefiere sobre un PUT: lo que el Dr. haya tocado a mano y no mandemos
 * (color, recordatorios, invitados, ubicación) se queda como está.
 * Con `status: "confirmed"` también restaura un evento cancelado.
 */
export async function patchEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  cambios: Partial<GCalEvent>,
): Promise<GCalEvent> {
  const res = await gcalFetch(
    env,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(cambios) },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Patch event failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Borra un evento de verdad (`events.delete`). El espejo NO usa esto a
 * propósito (cancela con `status: "cancelled"` para poder restaurar); existe
 * para limpiar eventos de PRUEBA que el flujo de la asistente crea en el
 * calendario real (ver waEquipoFlow.ts → pruebaEquipo). 404/410 cuentan como
 * borrado: el objetivo es que no exista, no que lo hayamos borrado nosotros.
 */
export async function deleteEvent(env: Env, calendarId: string, eventId: string): Promise<void> {
  const res = await gcalFetch(
    env,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const t = await res.text();
    throw new Error(`Delete event failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

/**
 * Crea un calendario SECUNDARIO propiedad del service account. Lo usa la
 * autoprueba del espejo para escribir en un sitio aislado: el calendario del
 * Dr. nunca entra en una prueba.
 */
export async function createCalendar(env: Env, summary: string): Promise<{ id: string }> {
  const res = await gcalFetch(env, "/calendars", {
    method: "POST",
    body: JSON.stringify({ summary, timeZone: "America/Bogota" }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Create calendar failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json<any>();
  if (!data?.id) throw new Error("Create calendar: respuesta sin id");
  return { id: data.id };
}

/**
 * Borra un calendario secundario del service account (el de la autoprueba).
 * Google rechaza borrar el calendario primario, y los compartidos por el Dr.
 * no son "propiedad" del service account: no hay forma de que esto le borre
 * el suyo.
 */
export async function deleteCalendar(env: Env, calendarId: string): Promise<void> {
  const res = await gcalFetch(env, `/calendars/${encodeURIComponent(calendarId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    throw new Error(`Delete calendar failed (${res.status}): ${t.slice(0, 200)}`);
  }
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
