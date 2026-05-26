/**
 * Auto-return-to-AI cron handler.
 *
 * Problem: when the AI escalates (urgencia/queja) or the doctor manually
 * takes a conversation, the contact's mode is set to "manual" in KV and the
 * AI stops responding. If the doctor forgets to flip it back to "auto",
 * future patient messages get ghosted.
 *
 * This cron periodically scans `wa:mode:*` keys and, for any contact that
 * has been idle (no inbound activity) for more than 30 minutes while in
 * "manual" mode, flips them back to "auto" so the AI resumes responding.
 *
 * Notification: every flip emits a Telegram message to all authorized
 * recipients so the team has an audit trail of the auto-return.
 *
 * Safety:
 * - All external calls (KV, Telegram) are wrapped in try/catch so a single
 *   failure does not abort the rest of the scan.
 * - HTML user-controlled content (name, phone) is escaped before inclusion
 *   in the Telegram message body.
 * - Only contacts currently in "manual" are touched — "review" and "auto"
 *   are left alone.
 */
import type { Env } from "../env";
import { setMode } from "../claudeAi";
import { getAllRecipients } from "../users";

const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
const MODE_KEY_PREFIX = "wa:mode:";

interface ContactState {
  name?: string;
  lastSeenAt: number;
}

export async function autoReturnToAI(env: Env): Promise<void> {
  // 1. Enumerate every contact that has a stored mode.
  //    `list()` is paginated; loop on `cursor` until `list_complete` is true.
  let cursor: string | undefined;
  let flipped = 0;

  do {
    let page: KVNamespaceListResult<unknown, string>;
    try {
      page = await env.STATE.list({ prefix: MODE_KEY_PREFIX, cursor });
    } catch (e) {
      console.log("[autoReturn] STATE.list failed:", (e as Error).message);
      return;
    }

    for (const key of page.keys) {
      const phone = key.name.slice(MODE_KEY_PREFIX.length);
      if (!phone) continue;

      // 2. Read the mode value. Skip anything that is not "manual".
      let mode: string | null;
      try {
        mode = await env.STATE.get(key.name);
      } catch (e) {
        console.log(`[autoReturn] STATE.get(mode) failed for ${phone}:`, (e as Error).message);
        continue;
      }
      if (mode !== "manual") continue;

      // 3. Read the contact's last activity. If we have no record of it,
      //    we cannot tell whether they are idle — be conservative and skip.
      let contactRaw: string | null;
      try {
        contactRaw = await env.STATE.get(`wa:contact:${phone}`);
      } catch (e) {
        console.log(`[autoReturn] STATE.get(contact) failed for ${phone}:`, (e as Error).message);
        continue;
      }
      if (!contactRaw) {
        console.log(`[autoReturn] no contact record for ${phone} — skipping`);
        continue;
      }

      let contact: ContactState;
      try {
        const parsed = JSON.parse(contactRaw) as Partial<ContactState>;
        if (typeof parsed?.lastSeenAt !== "number") {
          console.log(`[autoReturn] malformed contact record for ${phone} — skipping`);
          continue;
        }
        contact = {
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          lastSeenAt: parsed.lastSeenAt,
        };
      } catch {
        console.log(`[autoReturn] bad JSON in contact record for ${phone} — skipping`);
        continue;
      }

      const idleMs = Date.now() - contact.lastSeenAt;
      if (idleMs <= IDLE_THRESHOLD_MS) continue;

      // 4. Flip the mode back to "auto".
      try {
        await setMode(env, phone, "auto");
      } catch (e) {
        console.log(`[autoReturn] setMode failed for ${phone}:`, (e as Error).message);
        continue;
      }
      flipped++;
      console.log(
        `[autoReturn] flipped ${phone} back to auto (idle=${Math.round(idleMs / 60000)}min)`,
      );

      // 5. Notify all authorized recipients on Telegram.
      const safePhone = escapeHtml(phone);
      const safeName = contact.name ? escapeHtml(contact.name) : "";
      const suffix = safeName ? ` (${safeName})` : "";
      const text =
        `🤖 <b>Auto-modo restaurado</b> para <code>${safePhone}</code>${suffix} ` +
        `después de 30 min sin actividad. La IA volverá a responder.`;

      try {
        const recipients = await getAllRecipients(env);
        for (const chatId of recipients) {
          try {
            const tgRes = await fetch(
              `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  chat_id: chatId,
                  text,
                  parse_mode: "HTML",
                  disable_web_page_preview: true,
                }),
              },
            );
            console.log(
              `[autoReturn] notified chat=${chatId} phone=${phone} status=${tgRes.status}`,
            );
          } catch (e) {
            console.log(
              `[autoReturn] Telegram send failed for chat=${chatId} phone=${phone}:`,
              (e as Error).message,
            );
          }
        }
      } catch (e) {
        console.log(
          `[autoReturn] getAllRecipients failed for ${phone}:`,
          (e as Error).message,
        );
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(`[autoReturn] flipped ${flipped} contacts back to auto`);
}

/**
 * Minimal HTML escaper for Telegram `parse_mode: "HTML"`.
 * Telegram's HTML mode only requires escaping &, <, > — quotes are safe in
 * text/code bodies. Kept local so this module is self-contained.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
