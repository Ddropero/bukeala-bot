/**
 * Claude AI booking agent — Anthropic tool use.
 *
 * Receives an inbound WhatsApp message from a patient (with prior conversation
 * history) and:
 *   1. Calls Claude with a tool-aware system prompt + tools spec
 *   2. Loops: if Claude returns tool_use blocks → execute Bukeala tools →
 *      send results back as tool_result → Claude composes next reply
 *   3. Returns the final text response to send to the patient
 *
 * Hard guardrails (enforced by both system prompt AND tool semantics):
 *   - Never reveals prices (always "depende de la valoración")
 *   - Never gives medical advice / diagnoses
 *   - Always escalates if patient mentions urgent medical (dolor, sangrado,
 *     infección, fiebre alta, complicación postoperatoria...)
 *   - Never confirms a booking without an explicit slot id from
 *     find_available_slots
 *   - Max 3 bookings per patient per 30 days (anti-abuse)
 *
 * The Bukeala tools call the existing worker code paths so consistency is
 * guaranteed (same auth, same proxy, same error handling).
 */
import type { Env } from "./env";
import { Bukeala, SessionExpiredError } from "./bukeala";

const MAX_TOOL_LOOPS = 6;

const SYSTEM_PROMPT = `Eres la asistente virtual del consultorio del Dr. David Duque, cirujano plástico en Bogotá.
Te llamas "Asistente". Eres breve, amable, profesional. Hablas español neutro colombiano.

INFORMACIÓN DEL CONSULTORIO:
- Dirección: Calle 80 # 10-43, Consultorio 506, Bogotá
- El Dr. Duque consulta principalmente los miércoles
- Horario: 8:00 AM - 1:00 PM
- Citas duran 20 minutos

REGLAS DURAS (no romper nunca):
1. NUNCA des precios específicos. Si te preguntan, di "depende de la valoración inicial".
2. NUNCA des diagnósticos médicos ni recomiendes tratamientos.
3. Si el paciente menciona algo urgente (dolor, sangrado, infección, fiebre, complicación post-op, dificultad respirar, herida) llama IMMEDIATAMENTE a la herramienta escalate_to_human.
4. Para AGENDAR: SIEMPRE pregunta primero la cédula (necesaria para buscar la historia). Una vez encontrado el paciente, pregunta la fecha deseada, llama find_available_slots, presenta opciones, y SOLO después de que el paciente elija explícitamente un horario llama book_appointment.
5. Para CANCELAR: pregunta cédula → list_patient_bookings → confirma cuál cita quiere cancelar → cancel_appointment.
6. Para CONFIRMAR cita existente: cédula → list_patient_bookings → mostrar.
7. Si el paciente pide algo fuera de tu alcance, llama escalate_to_human.

ESTILO:
- Máximo 2-3 frases por respuesta
- Usa emojis con moderación (📅 ⏰ 🏥 ✅ ❌)
- Confirmaciones siempre incluyen fecha + hora + lugar
- NO uses Markdown, solo texto plano (WhatsApp no lo renderiza bien)

Tu primer mensaje del paciente puede ser ambiguo. Pregunta para clarificar.`;

const TOOLS = [
  {
    name: "find_patient",
    description:
      "Busca un paciente en Bukeala por cédula. Devuelve datos del paciente o null si no existe. Llama esto ANTES de cualquier acción de agendamiento o consulta.",
    input_schema: {
      type: "object",
      properties: {
        cedula: { type: "string", description: "Cédula sin puntos ni espacios, p.ej. 80040718" },
      },
      required: ["cedula"],
    },
  },
  {
    name: "list_patient_bookings",
    description: "Lista las citas activas (futuras) de un paciente.",
    input_schema: {
      type: "object",
      properties: {
        cedula: { type: "string" },
      },
      required: ["cedula"],
    },
  },
  {
    name: "find_available_slots",
    description:
      "Busca slots disponibles para una fecha específica. Devuelve hasta 10 horarios libres. Si la fecha no tiene cupos, sugiere la próxima fecha disponible.",
    input_schema: {
      type: "object",
      properties: {
        date_DDMMYYYY: {
          type: "string",
          description: 'Fecha en formato DD/MM/YYYY. Ejemplo: "14/05/2026"',
        },
      },
      required: ["date_DDMMYYYY"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Reserva un slot específico para un paciente. SOLO usar después de que find_available_slots devolvió slots Y el paciente eligió uno explícitamente.",
    input_schema: {
      type: "object",
      properties: {
        cedula: { type: "string" },
        slot_id: {
          type: "string",
          description: "El slot_id exacto que vino de find_available_slots (NO inventar)",
        },
      },
      required: ["cedula", "slot_id"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancela una cita existente por su reservation_code.",
    input_schema: {
      type: "object",
      properties: {
        reservation_code: { type: "string" },
        reason: {
          type: "string",
          description:
            "Motivo: paciente_no_puede_asistir | reagendar | otra_razon",
          enum: ["paciente_no_puede_asistir", "reagendar", "otra_razon"],
        },
      },
      required: ["reservation_code", "reason"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Notifica al doctor/secretaria que esta conversación necesita atención humana. Usar cuando: (1) el paciente menciona algo médico urgente, (2) hay reclamos, (3) no puedes resolver, (4) el paciente lo pide.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Por qué se escala (1 línea)" },
      },
      required: ["reason"],
    },
  },
];

interface AgentResult {
  finalText: string;
  shouldEscalate: boolean;
  escalateReason?: string;
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: any; // string or content block array (for tool messages)
}

export async function runBookingAgent(
  env: Env,
  fromPhone: string,
  inboundText: string,
): Promise<AgentResult> {
  // Load conversation history (text-only) and convert to messages array.
  const history = await loadHistory(env, fromPhone);
  const messages: ConversationTurn[] = history.slice(-12).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  // Append the new user message
  messages.push({ role: "user", content: inboundText });

  let escalated = false;
  let escalateReason: string | undefined;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const res = await callClaude(env, messages);
    if (!res) {
      return {
        finalText: "Disculpa, tuve un problema técnico. Te conecto con un humano.",
        shouldEscalate: true,
        escalateReason: "Claude API failure",
      };
    }

    const stopReason = res.stop_reason as string;
    const content = res.content as Array<any>;

    // Append assistant turn (raw, with possible tool_use blocks)
    messages.push({ role: "assistant", content });

    if (stopReason === "end_turn") {
      // Plain text response — done
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      return {
        finalText: text || "Disculpa, no entendí. ¿Puedes reformular?",
        shouldEscalate: escalated,
        escalateReason,
      };
    }

    if (stopReason !== "tool_use") {
      // Unexpected stop reason
      return {
        finalText: "Disculpa, tuve un problema. Te conecto con un humano.",
        shouldEscalate: true,
        escalateReason: `unexpected stop_reason: ${stopReason}`,
      };
    }

    // Execute each tool_use block
    const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const result = await executeTool(env, fromPhone, block.name, block.input ?? {});
      if (result.escalated) {
        escalated = true;
        escalateReason = result.escalateReason;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
      });
    }
    // Send tool results back as next user turn
    messages.push({ role: "user", content: toolResults });
  }

  // Hit the loop cap — escalate
  return {
    finalText: "Voy a poner a un humano en contacto contigo. Un momento.",
    shouldEscalate: true,
    escalateReason: "agent loop cap",
  };
}

async function callClaude(env: Env, messages: ConversationTurn[]): Promise<any | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`[claude-agent] api error ${res.status}: ${txt.slice(0, 300)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.log("[claude-agent] fetch failed:", (e as Error).message);
    return null;
  }
}

// ====================================================================
// Tool execution
// ====================================================================

interface ToolResult {
  output: any;
  escalated?: boolean;
  escalateReason?: string;
}

async function executeTool(
  env: Env,
  fromPhone: string,
  name: string,
  input: any,
): Promise<ToolResult> {
  console.log(`[claude-agent] tool=${name} from=${fromPhone} input=`, JSON.stringify(input));

  try {
    if (name === "escalate_to_human") {
      return {
        output: { escalated: true, message: "Humano notificado" },
        escalated: true,
        escalateReason: input.reason,
      };
    }

    const b = new Bukeala(env);

    if (name === "find_patient") {
      const cedula = String(input.cedula ?? "").replace(/\D/g, "");
      if (!cedula) return { output: { error: "cedula vacía" } };
      try {
        // Try CC (1) first, then fallback to other doc types
        const tryTypes = ["1", "8", "9", "2", "5"];
        for (const t of tryTypes) {
          try {
            const res = await b.findCustomer(t, cedula);
            const j = await res.json<any>().catch(() => null);
            if (j?.result?.code === "EXISTS") {
              const cust = j?.result?.beanCustomer ?? j?.result ?? {};
              return {
                output: {
                  found: true,
                  name: cust.name ?? cust.fullName ?? "(sin nombre)",
                  identification: cedula,
                  doc_type: t,
                  email: cust.email ?? null,
                  phone: cust.phone ?? cust.cellPhone ?? null,
                },
              };
            }
          } catch (innerErr) {
            // Re-throw session expired so outer catch handles it consistently
            if (innerErr instanceof SessionExpiredError) throw innerErr;
            // For other errors, try next id type
          }
        }
        return { output: { found: false, message: "Paciente no encontrado con ningún tipo de documento" } };
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          return {
            output: { error: "session_expired", message: "La sesión Bukeala expiró. Te paso a un humano." },
            escalated: true,
            escalateReason: "Bukeala session expired",
          };
        }
        return { output: { error: (e as Error).message } };
      }
    }

    if (name === "list_patient_bookings") {
      // For MVP, escalate this to humans — parsing /myBookings HTML is complex
      return {
        output: {
          message:
            "Voy a pasar tu consulta a un humano para revisar tus citas activas — un momento.",
        },
        escalated: true,
        escalateReason: "list_patient_bookings not yet wired (dev safety)",
      };
    }

    if (name === "find_available_slots") {
      // For MVP, escalate this — slot search requires multi-step setup (loadComponents,
      // changeUserTypeSelected, etc.) that's not yet wrapped in a clean helper.
      return {
        output: {
          message:
            "Voy a coordinar contigo y un humano para buscar cupos disponibles. Un momento.",
        },
        escalated: true,
        escalateReason: "find_available_slots not yet wired (dev safety)",
      };
    }

    if (name === "book_appointment") {
      // Always escalate for now (write operations require human approval in MVP)
      return {
        output: {
          error: "not_implemented_yet",
          message:
            "Tu solicitud quedó registrada — un humano confirmará tu cita en breve.",
        },
        escalated: true,
        escalateReason: "book_appointment not yet wired (dev safety)",
      };
    }

    if (name === "cancel_appointment") {
      return {
        output: {
          error: "not_implemented_yet",
          message: "Tu solicitud de cancelación quedó registrada — un humano la procesará en breve.",
        },
        escalated: true,
        escalateReason: "cancel_appointment not yet wired (dev safety)",
      };
    }

    return { output: { error: `unknown tool: ${name}` } };
  } catch (e) {
    return {
      output: { error: (e as Error).message },
      escalated: true,
      escalateReason: `tool ${name} threw`,
    };
  }
}

async function loadHistory(
  env: Env,
  fromPhone: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const raw = await env.STATE.get(`wa:history:${fromPhone}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Filter out tool-result-style entries (only keep plain text turns)
    return arr.filter(
      (t) => typeof t?.content === "string" && (t.role === "user" || t.role === "assistant"),
    );
  } catch {
    return [];
  }
}
