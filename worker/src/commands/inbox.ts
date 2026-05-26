/**
 * /inbox — unified view of ALL active WhatsApp conversations.
 *
 * Renders every contact under `wa:contact:{phone}` grouped by mode (AUTO /
 * MANUAL / REVIEW), sorted by lastSeenAt desc, with a snippet of the patient's
 * last message and inline buttons to reply (📱), inspect history (📋), or
 * toggle the AI mode (🤖/✋).
 *
 * Caps at 30 contacts; longer outputs are split across multiple Telegram
 * messages (~4096 char limit per send).
 */
import type { Env } from "../env";
import { getMode, type WaMode } from "../claudeAi";

// ====================================================================
// Constants
// ====================================================================
const MAX_CONTACTS = 30;
const SNIPPET_MAX_CHARS = 80;
const TG_MESSAGE_MAX_CHARS = 4000; // leave a small safety buffer under 4096

// ====================================================================
// Types
// ====================================================================
interface WaContactInfo {
  name?: string;
  lastSeenAt?: number;
  username?: string;
}

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

interface InboxRow {
  phone: string;
  name: string;
  lastSeenAt: number;
  mode: WaMode;
  lastUserMsg: string;
}

type InlineButton = { text: string; callback_data: string };

// ====================================================================
// Public API
// ====================================================================
export async function showInbox(env: Env, chatId: string): Promise<void> {
  // 1. List all wa:contact:{phone} keys.
  let listKeys: { name: string }[] = [];
  try {
    const list = await env.STATE.list({ prefix: "wa:contact:" });
    listKeys = list.keys;
  } catch (e) {
    await safeSend(env, chatId, `⚠️ Error listando contactos: ${escapeHtml((e as Error).message)}`);
    return;
  }

  if (listKeys.length === 0) {
    await safeSend(env, chatId, "📭 Sin contactos WhatsApp registrados todavía.");
    return;
  }

  // 2-3. Load info, mode and last user turn for each contact.
  const rows: InboxRow[] = [];
  for (const k of listKeys) {
    const phone = k.name.slice("wa:contact:".length);
    if (!phone) continue;

    let info: WaContactInfo = {};
    try {
      const raw = await env.STATE.get(k.name);
      if (raw) {
        info = JSON.parse(raw) as WaContactInfo;
      }
    } catch {
      // ignore malformed contact JSON
    }

    let mode: WaMode = "manual";
    try {
      mode = await getMode(env, phone);
    } catch {
      // fallback already set
    }

    let lastUserMsg = "";
    try {
      const histRaw = await env.STATE.get(`wa:history:${phone}`);
      if (histRaw) {
        const arr = JSON.parse(histRaw) as HistoryTurn[];
        if (Array.isArray(arr)) {
          for (let i = arr.length - 1; i >= 0; i--) {
            const turn = arr[i];
            if (turn && turn.role === "user" && typeof turn.content === "string") {
              lastUserMsg = turn.content;
              break;
            }
          }
        }
      }
    } catch {
      // ignore malformed history
    }

    rows.push({
      phone,
      name: (info.name && info.name.trim()) || "(sin nombre)",
      lastSeenAt: typeof info.lastSeenAt === "number" ? info.lastSeenAt : 0,
      mode,
      lastUserMsg,
    });
  }

  // 4. Group by mode.
  const byMode: Record<WaMode, InboxRow[]> = { auto: [], manual: [], review: [] };
  for (const r of rows) {
    byMode[r.mode].push(r);
  }

  // 5. Sort each group by lastSeenAt desc.
  for (const m of Object.keys(byMode) as WaMode[]) {
    byMode[m].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  const totalContacts = rows.length;

  // 7. Cap to first 30 across all groups, preserving group order (AUTO, MANUAL, REVIEW).
  const groupOrder: { mode: WaMode; label: string; icon: string }[] = [
    { mode: "auto", label: "AUTO", icon: "🤖" },
    { mode: "manual", label: "MANUAL", icon: "✋" },
    { mode: "review", label: "REVIEW", icon: "👁️" },
  ];

  const capped: { group: (typeof groupOrder)[number]; items: InboxRow[] }[] = [];
  let remaining = MAX_CONTACTS;
  for (const g of groupOrder) {
    const items = byMode[g.mode];
    if (items.length === 0) continue;
    const take = items.slice(0, Math.max(0, remaining));
    if (take.length > 0) {
      capped.push({ group: g, items: take });
      remaining -= take.length;
    }
    if (remaining <= 0) break;
  }

  const shown = capped.reduce((acc, c) => acc + c.items.length, 0);
  const extra = totalContacts - shown;

  // 6 & 8. Build header + grouped sections + buttons (one row per contact).
  const headerLines: string[] = [
    `💬 <b>Inbox WhatsApp</b> (${totalContacts} conversaciones activas)`,
    "",
  ];

  const buttons: InlineButton[][] = [];
  const bodySections: string[] = [];

  for (const c of capped) {
    const groupTotal = byMode[c.group.mode].length;
    const sectionLines: string[] = [
      `${c.group.icon} <b>${c.group.label} (${groupTotal})</b>`,
      "",
    ];
    for (const row of c.items) {
      const ago = row.lastSeenAt > 0 ? relativeTime(row.lastSeenAt) : "sin actividad";
      const snippet = row.lastUserMsg
        ? truncate(stripNewlines(row.lastUserMsg), SNIPPET_MAX_CHARS)
        : "";
      const snippetPart = snippet ? ` · "${escapeHtml(snippet)}"` : "";
      sectionLines.push(
        `${c.group.icon} <b>${escapeHtml(row.name)}</b> · <code>${escapeHtml(row.phone)}</code>`,
      );
      sectionLines.push(`   <i>${escapeHtml(ago)}${snippetPart}</i>`);
      sectionLines.push("");

      const shortName = (row.name.split(/[, ]/)[0] || row.name).slice(0, 20);
      const toggleIcon = row.mode === "auto" ? "✋" : "🤖";
      buttons.push([
        { text: `📱 ${shortName}`, callback_data: `waw:${row.phone}` },
        { text: "📋", callback_data: `wah:${row.phone}` },
        { text: toggleIcon, callback_data: `wam:${row.phone}` },
      ]);
    }
    bodySections.push(sectionLines.join("\n"));
  }

  const footerLines: string[] = [];
  if (extra > 0) {
    footerLines.push(`<i>+ ${extra} contacto${extra === 1 ? "" : "s"} adicional${extra === 1 ? "" : "es"}.</i>`);
  }
  footerLines.push(
    "<i>Toca 📱 para escribir · 📋 historial · 🤖/✋ alternar IA/manual</i>",
  );

  const fullText = [
    headerLines.join("\n"),
    bodySections.join("\n"),
    footerLines.join("\n"),
  ].join("\n");

  // 9. Send. If body exceeds Telegram's per-message ceiling, split into chunks
  // and attach the keyboard only to the last chunk so all buttons stay reachable.
  if (fullText.length <= TG_MESSAGE_MAX_CHARS) {
    await safeSend(env, chatId, fullText, buttons);
    return;
  }

  const chunks = splitForTelegram(fullText, TG_MESSAGE_MAX_CHARS);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await safeSend(env, chatId, chunks[i], isLast ? buttons : undefined);
  }
}

// ====================================================================
// Helpers
// ====================================================================
function relativeTime(ms: number): string {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "hace segundos";
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `hace ${Math.floor(diffSec / 3600)} h`;
  return `hace ${Math.floor(diffSec / 86400)} días`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripNewlines(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/**
 * Split a string into chunks that stay under `max` chars, breaking on newlines
 * when possible so we don't tear an HTML tag in half.
 */
function splitForTelegram(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const lines = text.split("\n");
  let buf = "";
  for (const line of lines) {
    const candidate = buf.length === 0 ? line : `${buf}\n${line}`;
    if (candidate.length > max) {
      if (buf.length > 0) {
        out.push(buf);
        buf = line.length > max ? line.slice(0, max) : line;
      } else {
        // Single line longer than max — hard-split it.
        for (let i = 0; i < line.length; i += max) {
          out.push(line.slice(i, i + max));
        }
        buf = "";
      }
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

async function safeSend(
  env: Env,
  chatId: string,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (buttons && buttons.length > 0) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (e) {
    console.log("[inbox] sendMessage failed:", (e as Error).message);
  }
}
