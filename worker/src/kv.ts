import type { Env } from "./env";
import { encryptJSON, decryptJSON } from "./crypto";

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
};

export type Session = {
  cookies: Cookie[];
  capturedAt: string;
};

export type ConversationState = {
  step:
    | "idle"
    | "awaiting_doc_type"
    | "awaiting_specialty"
    | "awaiting_date_range"
    | "awaiting_slot"
    | "awaiting_customer_id"
    | "awaiting_phone"
    | "awaiting_email"
    | "confirming";
  /** What action triggered awaiting_customer_id — controls what the bot does after the patient is selected. */
  mode?: "buscar" | "citas" | "cancelar";
  /** Numeric Bukeala idType selected by the user (1=CC, 8=TI, 9=RC, 2=CE, 5=PA). */
  selectedIdType?: string;
  componentId?: number;
  componentCode?: string;
  componentName?: string;
  selectedSlot?: {
    bookingComponentId: number;
    bookingComponentCode: string;
    areaId: number;
    areaCode: string;
    branchCode: string;
    secondExternalCode?: string;
    dateFormatted: string; // DD/MM/YY
    timeInSeconds: number;
    duration: number;
    label: string;
  };
  customer?: {
    name: string;
    identification: string;
    identificationType: string;
    gender: string;
    email?: string;
    phone?: string;
  };
  comment?: string;
};

const SESSION_KEY = "session:active";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h, ajusta tras observar duración real

export async function saveSession(env: Env, session: Session): Promise<void> {
  const blob = await encryptJSON(session, env.ENCRYPTION_KEY);
  await env.SESSIONS.put(SESSION_KEY, blob, { expirationTtl: SESSION_TTL_SECONDS });
}

export async function loadSession(env: Env): Promise<Session | null> {
  const blob = await env.SESSIONS.get(SESSION_KEY);
  if (!blob) return null;
  try {
    return await decryptJSON<Session>(blob, env.ENCRYPTION_KEY);
  } catch {
    return null;
  }
}

export async function clearSession(env: Env): Promise<void> {
  await env.SESSIONS.delete(SESSION_KEY);
}

/**
 * Apply Set-Cookie headers from a Bukeala response to the stored session.
 * Bukeala / Reblaze (the WAF) rotates `__uzm*` cookies and JSESSIONID
 * occasionally. Without updating, the worker uses stale cookies and gets
 * rejected after a few calls.
 *
 * Conservative behavior: only updates the value of cookies that were
 * already in the session. New cookies are ALSO added (e.g. JSESSIONID
 * may rotate to a new value but Reblaze may set new tracking cookies).
 */
export async function updateCookiesFromResponse(env: Env, res: Response): Promise<void> {
  const all = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const setCookies: string[] = all && all.length ? all : [];
  if (setCookies.length === 0) return;

  const session = await loadSession(env);
  if (!session) return;

  // Cookies we never let the worker manage. AWSALB/AWSALBCORS are AWS ALB
  // sticky-session cookies — if we accept new ones from the load balancer
  // we get pinned to a backend that does NOT have the browser's Java
  // session, and every call returns 302 to /cas/login. The browser already
  // captured the cookies that point to the right backend; we keep those.
  const STICKY_BLOCKLIST = new Set(["AWSALB", "AWSALBCORS", "AWSALBTG", "AWSALBTGCORS"]);

  // CRÍTICO: NO agregar como cookie NUEVA estos nombres si llegan por
  // Set-Cookie en una respuesta. El JSESSIONID correcto lo fija el login
  // fresco (vía /capture). Si Bukeala/Reblaze emite un JSESSIONID nuevo en
  // una ruta cualquiera y lo AGREGAMOS, terminamos con 2+ JSESSIONID y el
  // cookieHeader manda el equivocado → 302 intermitente. Solo ACTUALIZAMOS
  // el valor de uno que ya exista; nunca duplicamos.
  const UPDATE_ONLY = new Set(["JSESSIONID"]);

  let changed = false;
  for (const raw of setCookies) {
    // raw e.g. "JSESSIONID=abc; Path=/; HttpOnly; Secure"
    const semi = raw.indexOf(";");
    const head = semi >= 0 ? raw.slice(0, semi) : raw;
    const eq = head.indexOf("=");
    if (eq < 0) continue;
    const name = head.slice(0, eq).trim();
    const value = head.slice(eq + 1).trim();
    if (!name) continue;
    if (STICKY_BLOCKLIST.has(name)) continue;
    // Skip explicit deletions
    const isDeletion =
      value === "" ||
      /Max-Age=0/i.test(raw) ||
      /Expires=Thu, 01 Jan 1970/i.test(raw);
    if (isDeletion) continue;

    // Para JSESSIONID: actualizar TODAS las instancias existentes al mismo
    // valor (mantiene una sola sesión Java coherente), pero nunca crear una
    // nueva entrada si no existía.
    if (UPDATE_ONLY.has(name)) {
      let touched = false;
      for (const c of session.cookies) {
        if (c.name === name && c.value !== value) { c.value = value; touched = true; }
      }
      if (touched) changed = true;
      continue;
    }

    const existing = session.cookies.find((c) => c.name === name);
    if (existing) {
      if (existing.value !== value) {
        existing.value = value;
        changed = true;
      }
    } else {
      // Add new cookie (default domain to .tuscitasmedicas.com)
      session.cookies.push({
        name,
        value,
        domain: parseAttr(raw, "Domain") ?? ".tuscitasmedicas.com",
        path: parseAttr(raw, "Path") ?? "/",
        httpOnly: /HttpOnly/i.test(raw),
      });
      changed = true;
    }
  }

  // Cap de seguridad: si por la razón que sea acumulamos demasiadas cookies
  // (Reblaze rota __uzm* sin parar), nos quedamos con las relevantes y las
  // últimas. Evita el inflado a 140 que rompía el routing.
  if (session.cookies.length > 60) {
    const essential = session.cookies.filter((c) =>
      /^(JSESSIONID|XB-TRANSACTION|SERVERID|TS[0-9a-f]+)/i.test(c.name));
    const rest = session.cookies.filter((c) =>
      !/^(JSESSIONID|XB-TRANSACTION|SERVERID|TS[0-9a-f]+)/i.test(c.name));
    session.cookies = [...essential, ...rest.slice(-40)];
    changed = true;
  }

  if (changed) {
    // NO tocar capturedAt aquí: marca cuándo se hizo el LOGIN fresco (lo fija
    // /capture). Si lo reseteáramos en cada rotación de cookie, la "edad" de
    // la sesión nunca crecería y el refresh preventivo (age>12min) jamás
    // dispararía. Solo persistimos los valores de cookie actualizados.
    await saveSession(env, session);
  }
}

function parseAttr(raw: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, "i");
  const m = raw.match(re);
  return m ? m[1].trim() : undefined;
}

/**
 * Build a `Cookie:` header value for a given hostname. Filters cookies
 * whose `domain` matches (or is a parent of) the hostname, then dedupes
 * by name keeping the most specific (longest path / host-only).
 *
 * Default hostname is `appoint.tuscitasmedicas.com` for backward
 * compatibility. Pass `app01.colsanitas.com` for CAS calls (TGC cookie).
 */
export async function cookieHeader(
  env: Env,
  hostname = "appoint.tuscitasmedicas.com",
): Promise<string | null> {
  const s = await loadSession(env);
  if (!s) return null;
  const h = hostname.toLowerCase();
  const cookies = s.cookies.filter((c) => {
    const d = (c.domain || "").toLowerCase();
    if (!d) return false;
    if (d === h) return true;
    if (d.startsWith(".")) {
      const bare = d.slice(1);
      return h === bare || h.endsWith("." + bare);
    }
    return false;
  });
  if (cookies.length === 0) return null;
  const byName = new Map<string, typeof cookies[number]>();
  for (const c of cookies) {
    const existing = byName.get(c.name);
    if (!existing) {
      byName.set(c.name, c);
      continue;
    }
    // Para JSESSIONID: preferir el ligado a /keraltyadscritos (el servlet que
    // usan las consultas). Un JSESSIONID de /admin rompe findCustomer.
    if (c.name === "JSESSIONID") {
      const cIsKeralty = (c.path || "").includes("keraltyadscritos");
      const exIsKeralty = (existing.path || "").includes("keraltyadscritos");
      if (cIsKeralty && !exIsKeralty) byName.set(c.name, c);
      continue;
    }
    const newer =
      (c.path?.length ?? 0) > (existing.path?.length ?? 0) ||
      (!c.domain.startsWith(".") && existing.domain.startsWith("."));
    if (newer) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join("; ");
}

const STATE_TTL_SECONDS = 60 * 30;

export async function loadState(env: Env, chatId: string): Promise<ConversationState> {
  const raw = await env.STATE.get(`state:${chatId}`);
  if (!raw) return { step: "idle" };
  try {
    return JSON.parse(raw) as ConversationState;
  } catch {
    return { step: "idle" };
  }
}

export async function saveState(env: Env, chatId: string, state: ConversationState): Promise<void> {
  await env.STATE.put(`state:${chatId}`, JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

export async function clearState(env: Env, chatId: string): Promise<void> {
  await env.STATE.delete(`state:${chatId}`);
}
