/**
 * Claude AI integration for WhatsApp auto-replies.
 *
 * The bot can run in 3 modes per conversation (saved in KV STATE):
 *   - "manual" (default): forward inbound messages to Telegram, doctor uses
 *      /wa_reply manually.
 *   - "review":           on each inbound message, ask Claude for a draft reply
 *                         and send it to Telegram with a "✅ Send / ✏️ Edit"
 *                         inline keyboard so the doctor approves before sending.
 *   - "auto":             Claude replies directly without confirmation.
 *
 * The system prompt encodes Dr. Duque's tone and guardrails: short, friendly,
 * NEVER promises medical results, NEVER schedules without doctor's approval,
 * always escalates to human for anything off-script.
 */
import type { Env } from "./env";

const SYSTEM_PROMPT = `Eres la asistente virtual del consultorio del Dr. David Duque, cirujano plástico en Bogotá. Te llamas "Asistente".

CONTEXTO:
- Consultorio: Calle 80 # 10-43, Consultorio 506, Bogotá
- Especialidad: Cirugía plástica estética y reconstructiva
- Atención principalmente a pacientes de Colsanitas y consulta particular
- El Dr. Duque consulta los miércoles principalmente

REGLAS DURAS (no romper nunca):
1. NUNCA prometas resultados específicos de un procedimiento médico.
2. NUNCA des diagnósticos, ni recomiendes tratamientos quirúrgicos. Para eso es la consulta.
3. NUNCA agendes ni canceles citas tú directamente. Si el paciente quiere agendar/cancelar, dile que vas a coordinar con el equipo y NO confirmes hora.
4. Si el paciente pregunta por precios específicos, di que dependen de la valoración y que el equipo lo contactará.
5. Si la pregunta es médica seria, urgente, sobre complicaciones, o algo fuera de lo administrativo, NO RESPONDAS y devuelve EXACTAMENTE el texto "[ESCALAR]" para que un humano tome.
6. Sé breve (máximo 2-3 frases), amable, en español neutro colombiano. Nada de emojis excesivos.
7. Si saludan, saluda y pregunta en qué los puedes ayudar.

EJEMPLOS:
Paciente: "Hola, quería información sobre rinoplastia"
Tú: "¡Hola! Con gusto. Para rinoplastia el Dr. Duque hace una valoración inicial de ~30 min para revisar tu caso y explicarte el procedimiento. ¿Quieres que el equipo te contacte para agendar la valoración?"

Paciente: "Cuánto cuesta una abdominoplastia?"
Tú: "El valor depende de la valoración (cada caso es único). El Dr. Duque te da el costo exacto en la consulta. ¿Te gustaría agendar?"

Paciente: "Tengo una infección post-quirúrgica desde ayer"
Tú: "[ESCALAR]"

Paciente: "Necesito cancelar mi cita del miércoles"
Tú: "Por supuesto, voy a coordinar con el equipo para reagendarte o cancelar. ¿Me confirmas tu nombre completo?"

Si NO sabes algo o tienes duda, devuelve "[ESCALAR]".`;

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeReply {
  text: string;
  shouldEscalate: boolean;
}

/**
 * Get a Claude-suggested reply for an inbound WhatsApp message.
 * Pulls last ~10 turns of conversation history from KV.
 */
export async function suggestReply(
  env: Env,
  fromPhone: string,
  inboundText: string,
): Promise<ClaudeReply> {
  const history = await loadHistory(env, fromPhone);
  history.push({ role: "user", content: inboundText });

  const body = {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 250,
    system: SYSTEM_PROMPT,
    messages: history.slice(-10), // last 10 turns
  };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log("[claude] fetch failed:", (e as Error).message);
    return { text: "[ESCALAR]", shouldEscalate: true };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.log(`[claude] api error ${res.status}: ${errText.slice(0, 300)}`);
    return { text: "[ESCALAR]", shouldEscalate: true };
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(" ")
    .trim();

  const shouldEscalate = text.includes("[ESCALAR]") || text.length === 0;
  return { text, shouldEscalate };
}

/**
 * Append a turn to the persisted conversation history (for both directions).
 * History is rolling (last 20 turns).
 */
export async function appendHistory(
  env: Env,
  fromPhone: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const history = await loadHistory(env, fromPhone);
  history.push({ role, content });
  const trimmed = history.slice(-20);
  await env.STATE.put(`wa:history:${fromPhone}`, JSON.stringify(trimmed), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
  });
}

async function loadHistory(env: Env, fromPhone: string): Promise<ClaudeMessage[]> {
  const raw = await env.STATE.get(`wa:history:${fromPhone}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch {
    // bad json, drop
  }
  return [];
}

// ====================================================================
// Mode (manual / review / auto) per WhatsApp contact
// ====================================================================

export type WaMode = "manual" | "review" | "auto";

export async function getMode(env: Env, fromPhone: string): Promise<WaMode> {
  const v = (await env.STATE.get(`wa:mode:${fromPhone}`)) as WaMode | null;
  return v ?? "manual";
}

export async function setMode(env: Env, fromPhone: string, mode: WaMode): Promise<void> {
  await env.STATE.put(`wa:mode:${fromPhone}`, mode, { expirationTtl: 60 * 60 * 24 * 30 });
}
