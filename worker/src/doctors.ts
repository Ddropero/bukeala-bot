import type { Env } from "./env";

/**
 * Multi-doctor support.
 *
 * Each `Doctor` bundles every Bukeala identifier the bot needs to act on
 * behalf of one professional: the branch, the area (which is the doctor's
 * calendar inside Bukeala) and the human-readable name shown to users.
 *
 * To add a new doctor in the future: append one entry to `DOCTORS` below.
 */
export type Doctor = {
  /** Unique stable key. Used in KV and Telegram callback_data. */
  id: string;
  /** Display name shown in Telegram. */
  name: string;
  /** Bukeala branch numeric id (string form, matches env.BRANCH_ID). */
  branchId: string;
  /** Bukeala branch code (the legacy text code, e.g. "7960"). */
  branchCode: string;
  /** Bukeala area numeric id — the doctor's calendar id. */
  areaId: number;
  /** Bukeala area code (the legacy text code, e.g. "80040718"). */
  areaCode: string;
};

/**
 * Registered doctors. To add a new doctor, append another object literal
 * with that doctor's Bukeala identifiers.
 */
export const DOCTORS: Doctor[] = [
  {
    id: "duque",
    name: "DUQUE ROPERO DAVID FERNANDO",
    branchId: "456",
    branchCode: "7960",
    areaId: 1074,
    areaCode: "80040718",
  },
];

/** KV key (in env.STATE) holding the id of the active doctor. */
const ACTIVE_DOCTOR_KEY = "activeDoctorId";

/**
 * Returns the currently selected doctor, falling back to the first one in
 * `DOCTORS` if nothing is stored or the stored id no longer exists.
 */
export async function getActiveDoctor(env: Env): Promise<Doctor> {
  const fallback = DOCTORS[0];
  if (!fallback) {
    throw new Error("doctors.ts: DOCTORS list is empty");
  }
  const stored = await env.STATE.get(ACTIVE_DOCTOR_KEY);
  if (!stored) return fallback;
  const found = DOCTORS.find((d) => d.id === stored);
  return found ?? fallback;
}

/**
 * Persist the active doctor selection. Throws if `id` is unknown so callers
 * never silently set an invalid value.
 */
export async function setActiveDoctor(env: Env, id: string): Promise<void> {
  const exists = DOCTORS.some((d) => d.id === id);
  if (!exists) {
    throw new Error(`doctors.ts: unknown doctor id "${id}"`);
  }
  await env.STATE.put(ACTIVE_DOCTOR_KEY, id);
}

/**
 * Build a Telegram inline_keyboard for selecting a doctor.
 * Returns an empty `inline_keyboard` when there is nothing to choose
 * (i.e. only one doctor configured) so callers can short-circuit the UI.
 */
export function buildDoctorSelectorKeyboard(): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  if (DOCTORS.length <= 1) {
    return { inline_keyboard: [] };
  }
  return {
    inline_keyboard: DOCTORS.map((d) => [
      { text: d.name, callback_data: `doctor:${d.id}` },
    ]),
  };
}
