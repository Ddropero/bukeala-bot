/**
 * Multi-user access control with roles.
 *
 * Two-tier authorization:
 *   1. Primary doctor: env.ALLOWED_CHAT_ID  (always doctor role, hard-coded
 *      so the system can never lock you out even if KV is wiped).
 *   2. Additional users: stored in KV under `users:list` as JSON
 *      [{ chatId, role, name, addedAt, addedBy }].
 *
 * Roles:
 *   - "doctor":     full access, can add/remove users, can take all admin
 *                   actions (e.g. `/wa_mode <num> auto`, `/doctor` switch).
 *   - "secretary":  full operational access — can book, cancel, search,
 *                   reply WhatsApp, see agenda. CAN'T add users or toggle
 *                   admin-only flags.
 *
 * Notification routing:
 *   - getAllRecipients()        → broadcast to everyone (new bookings, WA inbound)
 *   - getOperationalRecipients()→ doctor + secretaries (alerts, daily summary)
 *   - getDoctorOnly()           → only doctors (TGC expired, system errors)
 */
import type { Env } from "./env";

export type Role = "doctor" | "secretary";

export interface User {
  chatId: string;
  role: Role;
  name: string;
  addedAt: string;
  addedBy?: string;
}

const KV_USERS = "users:list";

/**
 * Load the additional users (NOT including the primary doctor).
 */
async function loadAdditionalUsers(env: Env): Promise<User[]> {
  try {
    const raw = await env.STATE.get(KV_USERS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (u): u is User =>
        typeof u?.chatId === "string" &&
        (u.role === "doctor" || u.role === "secretary"),
    );
  } catch {
    return [];
  }
}

async function saveAdditionalUsers(env: Env, users: User[]): Promise<void> {
  await env.STATE.put(KV_USERS, JSON.stringify(users));
}

/**
 * Returns the full users list, with the primary doctor first.
 */
export async function listUsers(env: Env): Promise<User[]> {
  const additional = await loadAdditionalUsers(env);
  const primary: User = {
    chatId: env.ALLOWED_CHAT_ID,
    role: "doctor",
    name: "Doctor (principal)",
    addedAt: "—",
  };
  // Don't duplicate if primary chat id was also added to additional list
  const dedup = additional.filter((u) => u.chatId !== env.ALLOWED_CHAT_ID);
  return [primary, ...dedup];
}

export async function isAllowed(env: Env, chatId: string): Promise<boolean> {
  if (chatId === env.ALLOWED_CHAT_ID) return true;
  const users = await loadAdditionalUsers(env);
  return users.some((u) => u.chatId === chatId);
}

export async function getRole(env: Env, chatId: string): Promise<Role | null> {
  if (chatId === env.ALLOWED_CHAT_ID) return "doctor";
  const users = await loadAdditionalUsers(env);
  return users.find((u) => u.chatId === chatId)?.role ?? null;
}

export async function getUserName(env: Env, chatId: string): Promise<string> {
  if (chatId === env.ALLOWED_CHAT_ID) return "Doctor";
  const users = await loadAdditionalUsers(env);
  return users.find((u) => u.chatId === chatId)?.name ?? "Desconocido";
}

export async function isDoctor(env: Env, chatId: string): Promise<boolean> {
  return (await getRole(env, chatId)) === "doctor";
}

export async function addUser(
  env: Env,
  newChatId: string,
  role: Role,
  name: string,
  addedBy: string,
): Promise<{ ok: boolean; message: string }> {
  if (!/^-?\d+$/.test(newChatId)) {
    return { ok: false, message: "chatId inválido (debe ser numérico)" };
  }
  if (newChatId === env.ALLOWED_CHAT_ID) {
    return { ok: false, message: "Ese ID ya es el doctor principal" };
  }
  const users = await loadAdditionalUsers(env);
  if (users.some((u) => u.chatId === newChatId)) {
    return { ok: false, message: "Usuario ya existe — usa /remove_user primero si quieres cambiar su rol" };
  }
  users.push({
    chatId: newChatId,
    role,
    name,
    addedAt: new Date().toISOString(),
    addedBy,
  });
  await saveAdditionalUsers(env, users);
  return { ok: true, message: `Agregado ${name} (${role}) con chatId ${newChatId}` };
}

export async function removeUser(
  env: Env,
  chatId: string,
): Promise<{ ok: boolean; message: string }> {
  if (chatId === env.ALLOWED_CHAT_ID) {
    return { ok: false, message: "No puedes remover al doctor principal" };
  }
  const users = await loadAdditionalUsers(env);
  const before = users.length;
  const after = users.filter((u) => u.chatId !== chatId);
  if (after.length === before) {
    return { ok: false, message: "Usuario no encontrado" };
  }
  await saveAdditionalUsers(env, after);
  return { ok: true, message: `Removido chatId ${chatId}` };
}

/**
 * For broadcasts: everyone allowed (doctor + all secretaries).
 * Used for: new bookings, WhatsApp inbound, daily summary.
 */
export async function getAllRecipients(env: Env): Promise<string[]> {
  const users = await listUsers(env);
  // Dedup by chatId
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of users) {
    if (!seen.has(u.chatId)) {
      seen.add(u.chatId);
      out.push(u.chatId);
    }
  }
  return out;
}

/**
 * For tech alerts (TGC expired, worker errors): doctors only.
 * Secretaries shouldn't get noisy ops alerts.
 */
export async function getDoctorRecipients(env: Env): Promise<string[]> {
  const users = await listUsers(env);
  return users.filter((u) => u.role === "doctor").map((u) => u.chatId);
}
