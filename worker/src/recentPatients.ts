import type { Env } from "./env";

export type RecentPatient = {
  name: string;
  identification: string;
  identificationType: string; // "C" | "T" | "R" | "E" | "P"
  gender: string;             // "F" | "M"
  email?: string;
  phone?: string;
  lastSeen: string;           // ISO timestamp
};

const RECENT_KEY = "recent:patients";
const MAX_RECENT = 15;

/**
 * Map letter-style identificationType (as stored in state.customer) to the
 * numeric idType expected by the Bukeala API endpoints.
 *   "C" → "1" (CC, Cédula de Ciudadanía)
 *   "T" → "8" (TI, Tarjeta de Identidad)
 *   "R" → "9" (RC, Registro Civil)
 *   "E" → "2" (CE, Cédula de Extranjería)
 *   "P" → "5" (PA, Pasaporte)
 * Unknown letters fall back to "1" (CC) — same conservative default the
 * cedula flow uses when no explicit selection has been made.
 */
export function letterToBukealaIdType(letter: string): string {
  switch ((letter || "").toUpperCase()) {
    case "C":
      return "1";
    case "T":
      return "8";
    case "R":
      return "9";
    case "E":
      return "2";
    case "P":
      return "5";
    default:
      return "1";
  }
}

function isRecentPatient(value: unknown): value is RecentPatient {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.identification === "string" &&
    typeof v.identificationType === "string" &&
    typeof v.gender === "string" &&
    typeof v.lastSeen === "string" &&
    (v.email === undefined || typeof v.email === "string") &&
    (v.phone === undefined || typeof v.phone === "string")
  );
}

/** Load the recent-patients list (max 15). Returns [] if missing or corrupt. */
export async function loadRecentPatients(env: Env): Promise<RecentPatient[]> {
  const raw = await env.STATE.get(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list = parsed.filter(isRecentPatient);
    return list.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * Add a patient to the front of the recent list. Dedup by `identification`:
 * if the patient is already in the list, the existing entry is removed and
 * the new one is inserted at the front (with a fresh `lastSeen`). The list
 * is trimmed to {@link MAX_RECENT}.
 */
export async function addRecentPatient(
  env: Env,
  p: Omit<RecentPatient, "lastSeen">,
): Promise<void> {
  if (!p || !p.identification) return;
  const current = await loadRecentPatients(env);
  const filtered = current.filter((rp) => rp.identification !== p.identification);
  const entry: RecentPatient = {
    name: p.name,
    identification: p.identification,
    identificationType: p.identificationType,
    gender: p.gender,
    email: p.email,
    phone: p.phone,
    lastSeen: new Date().toISOString(),
  };
  const next = [entry, ...filtered].slice(0, MAX_RECENT);
  await env.STATE.put(RECENT_KEY, JSON.stringify(next));
}

/** Find a patient in the recent list by `identification`. Returns null if absent. */
export async function findRecentPatient(
  env: Env,
  identification: string,
): Promise<RecentPatient | null> {
  if (!identification) return null;
  const list = await loadRecentPatients(env);
  return list.find((rp) => rp.identification === identification) ?? null;
}
