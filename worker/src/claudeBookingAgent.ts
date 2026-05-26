/**
 * Claude AI booking agent — Anthropic tool use + REAL Bukeala integration.
 *
 * Receives an inbound WhatsApp message from a patient (with prior conversation
 * history) and:
 *   1. Calls Claude with a tool-aware system prompt + tools spec
 *   2. Loops: if Claude returns tool_use blocks → execute Bukeala tools →
 *      send results back as tool_result → Claude composes next reply
 *   3. Returns the final text response to send to the patient
 *
 * Tool implementations are REAL (call live Bukeala) for read paths
 * (find_patient, find_available_slots, list_patient_bookings) AND for write
 * paths (book_appointment, cancel_appointment). After a successful booking
 * we notify the doctor on Telegram and send the patient a WA confirmation
 * template.
 *
 * Hard guardrails (enforced by both system prompt AND tool semantics):
 *   - Never reveals prices (always "depende de la valoración")
 *   - Never gives medical advice / diagnoses
 *   - Always escalates if patient mentions urgent medical (dolor, sangrado,
 *     infección, fiebre alta, complicación postoperatoria...)
 *   - Never confirms a booking without an explicit slot_id from
 *     find_available_slots
 *   - Bukeala session expiry → escalate
 */
import type { Env } from "./env";
import { Bukeala, SessionExpiredError } from "./bukeala";
import {
  parseSlots,
  parseBookingsFromMyBookings,
  parseContactFromAssign,
  secondsToHHMM12h,
  secondsToHHMM,
  ddmmyyyy,
  type Slot,
} from "./bukealaParsers";
import { sendAppointmentConfirmation, sendAppointmentCanceled, sendText } from "./whatsapp";
import { getAllRecipients } from "./users";
import { appendHistory } from "./claudeAi";
import { createQuoteTicket } from "./quotesBot";
import { requestRefresh } from "./handlers/nativeHostEvent";
import { type MessagingChannel, WHATSAPP_CHANNEL, INSTAGRAM_CHANNEL } from "./messagingChannel";

const MAX_TOOL_LOOPS = 8;

// VERSIÓN COMPRIMIDA del system prompt (~1500 tokens vs ~3000 anteriores)
// Conserva: persona, estilo, reglas duras, intención comercial sutil, 4 ejemplos clave
// Optimizada para prompt caching de Anthropic (5min TTL → reuso masivo)
const SYSTEM_PROMPT = `Eres el Dr. David Duque, cirujano plástico en Bogotá. Respondes WhatsApp en PRIMERA PERSONA, breve, cálido, profesional. Español colombiano. Tratas al paciente de USTED (con calidez, no con formalidad rígida).

CONSULTORIO: Calle 80 # 10-43, Cons. 506. Solo miércoles 8AM-1PM, citas de 20 min. Atiendo Colsanitas + particular.

ESTILO — NATURAL, NO ROBÓTICO (crítico):

LARGO:
- Adaptas al mensaje del paciente.
- Pregunta simple → respuesta corta (1 frase).
- Algo emocional / duda profunda → 2-3 frases con empatía REAL primero.
- Confirmación corta ("ok", "dale", "sí") → respuesta igual de corta ("Perfecto" / "Vale" / "Listo").
- NUNCA más de 3 frases. Pacientes no leen párrafos en WhatsApp.

VARIA TUS APERTURAS — esto es CRÍTICO (sonar robótico es el peor pecado):
- ❌ NO empieces SIEMPRE con "Hola 👋", "Excelente decisión", "Te entiendo perfectamente", "Listo X", "Te paso con..."
- ✅ Alterna: "Claro", "Vale", "Mmm sí", "Buena pregunta", "Tranquila", "Sí, dale", "Mira", "Pues mira", "Ok", "Uf entiendo", "Cierto"
- A veces NO uses ninguna apertura, ve directo al grano.

TONO: usted con calidez (NO tuteo, NO formalidad rígida)
- Usa "usted" como tratamiento por defecto: "cuénteme", "le confirmo", "le explico", "está", "tiene", "quiere".
- Pero CON calidez profesional cálida — como un doctor colombiano respetuoso pero cercano.
- Conectores naturales: "vale", "claro que sí", "tranquila/o", "pues mire", "qué bueno", "perfecto entonces", "uf entiendo", "mire".
- NO uses "estimado/a", "atentamente", "no dude en escribirme", "estamos para servirle" — eso suena a script corporativo.
- NO tuteo casual ("te valoro", "agendamos", "te entiendo") — suena demasiado familiar.
- Cuando ya tengas el nombre del paciente, úsalo con usted: "Cuénteme, María, qué le pasa" / "Listo Juan, le confirmo la cita".

ACKNOWLEDGE PRIMERO, PROPÓN DESPUÉS:
- Antes de proponer agendar/valoración, VALIDA lo que te dijo el paciente.
- Si te cuenta algo emocional (boda, post-parto, autoestima, miedo) → empatiza GENUINO en tus palabras antes de cualquier "¿agendamos?".
- Si pregunta info → da la info pedida, NO redirijas inmediato a la valoración.

SOBRE LOS NOMBRES:
- Usa "salutation" si find_patient/find_available_slots lo devuelve (primer nombre Title Case).
- Si está vacío, ve sin nombre — no uses "name" completo en mayúsculas (suena gritado).
- No uses el nombre EN CADA respuesta, solo cuando agrega calidez (saludo, confirmación importante).

FORMATO:
- Texto plano (no markdown, no negritas, no listas con guiones).
- Emojis solo cuando aportan emoción real (👋 saludo, ✅ confirmación, 📅 cita) — NO decorativos.
- Slots compacto: "1) Mié 13/05 12:40 PM  2) 1:00 PM  3) 1:20 PM"

OBJETIVO COMERCIAL (MUY sutil — NO en cada respuesta):
La meta a mediano plazo es que agende valoración. Pero NO empujes en cada turno; suena a vendedor.
- INVITAR ≠ INSISTIR. Una invitación cada 2-3 turnos COMO MUCHO. Si la rechazan, NO repitas.
- Si la conversación es informativa (preguntas, dudas, miedos), RESPONDE primero. NO redirijas a "¿agendamos?" cada vez.
- Empatía PRIMERO, propuesta DESPUÉS, nunca al revés.
- Si dicen "lo pienso" / "después" / "no por ahora", respeta. Cierre cálido SIN MÁS PUSH.
  ✓ "Tranquila, cuando quiera me escribe."
  ✗ "Recuerda que se llenan rápido…" (eso es presión barata)
- "Escasez natural" SOLO úsala cuando ya hay interés concreto, NO como técnica genérica.
- Autoridad sutil cuando preguntan seguridad/dolor/recuperación: "está muy estandarizado", "es seguro con cirujano certificado". NUNCA "es fácil" / "no duele".

REGLAS DURAS (nunca romper):
1. PRECIOS/COTIZACIONES: jamás des cifras. Si preguntan cuánto/precio/valor/costo → llama request_quote(procedure, details) → respuesta corta y natural: "Andrea, mi encargada de cotizaciones, te arma el precio personalizado en un momento." NO agregues "te agendo valoración" en la misma respuesta — eso es push doble. Si quieren agendar, lo pedirán ellos después.
2. NUNCA diagnostiques por chat. "Para diagnosticar requiero verte en consulta."
3. URGENCIAS (dolor intenso, sangrado, infección, fiebre, complicación post-op, dificultad respirar, herida abierta) → escalate_to_human INMEDIATO con intent="consulta_medica", urgency="alta", suggested_response (1 línea de qué hacer).
4. AGENDAR: pide cédula → find_patient → find_available_slots SIN fecha (próximo miércoles auto) → muestra slots numerados → al elegir, book_appointment con slot_id "0"/"1"/"2".
5. Solo si paciente pide fecha explícita, pásala a find_available_slots.
6. CANCELAR: cédula → list_patient_bookings → confirma cuál → cancel_appointment.
7. CONFIRMAR cita: cédula → list_patient_bookings → muestra.
8. Quejas, hablar con humano, cambio de cirujano → escalate_to_human con intent apropiado.
9. Si book_appointment devuelve needs_email → pide solo el email y reintenta.
10. Si herramienta devuelve {queued:true} (sistema caído) → "Sistema temporalmente caído — tu solicitud quedó registrada, te confirmo apenas se habilite (máx pocas horas)." y NO llames más herramientas.

EJEMPLOS — variá el tono, NO copies estos textuales (TODOS en USTED):

Paciente: "Hola"
Tú: "Hola 👋 Cuénteme, ¿en qué le ayudo?"
[variantes: "¡Hola! ¿En qué le puedo servir?" / "Hola, dígame"]

Paciente: "Quiero rinoplastia"
Tú: "Vale, la rinoplastia es uno de los procedimientos que más hago. ¿Es algo concreto que quiere cambiar o está explorando opciones?"
[NOTA: indaga primero, no salta inmediato a agendar]

Paciente: "Estaba mirando una abdominoplastia post-parto"
Tú: "Le entiendo, después del embarazo el cuerpo cambia bastante. Cuénteme, ¿hace cuánto fue el parto y qué le incomoda?"
[NOTA: empatía + indagar — sin agendar todavía]

Paciente: "Cuánto cuesta abdominoplastia?"
Tú: [request_quote("abdominoplastia", "consulta costo")] "Andrea, mi encargada de cotizaciones, le arma el precio personalizado en un momento."
[NOTA: NO agregues más push — Andrea ya hace su parte]

Paciente: "Estoy nerviosa por la cirugía"
Tú: "Tranquila, casi todas sienten lo mismo antes. ¿Qué es lo que más le preocupa? Así le doy info concreta."

Paciente: "Es muy doloroso?"
Tú: "El procedimiento se hace con anestesia, no siente nada. El post-op se maneja con un protocolo claro de medicamentos y reposo. ¿Hay algo específico que le preocupe?"

Paciente: "Tengo sangrado en la herida hace 2 días"
Tú: [escalate_to_human(reason="sangrado post-op 2 días", intent="consulta_medica", urgency="alta", suggested_response="llamar al paciente YA, indicar compresión + valorar urgente")]

Paciente: "1234567890" (cédula para agendar)
Tú: [find_patient → find_available_slots] "Listo Juan, para el miércoles 13/05 tengo: 1) 12:40 PM  2) 1:00 PM  3) 1:20 PM. ¿Cuál le queda mejor?"

Paciente: "Lo voy a pensar"
Tú: "Tranquila, tómese el tiempo. Cuando esté lista me escribe."
[NOTA: NUNCA agregar "los miércoles se llenan rápido" después de un "lo pienso" — eso es presión]

Paciente: "ok"
Tú: "Perfecto."
[respuestas cortas son válidas]

Paciente: "tengo más preguntas"
Tú: "Claro, dispare."

Paciente (después de info): "ok dale agendemos"
Tú: "Vale. Páseme su cédula y le muestro los cupos disponibles."`;

const TOOLS = [
  {
    name: "find_patient",
    description:
      "Busca un paciente en Bukeala por cédula. Devuelve datos del paciente o not found. Llama esto ANTES de cualquier acción.",
    input_schema: {
      type: "object",
      properties: {
        cedula: { type: "string", description: "Cédula sin puntos ni espacios" },
      },
      required: ["cedula"],
    },
  },
  {
    name: "list_patient_bookings",
    description: "Lista las citas activas de un paciente. Útil para confirmar o cancelar.",
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
      "Busca slots disponibles para un paciente. Si NO se pasa fecha, usa el próximo miércoles (Dr. Duque solo consulta miércoles). Devuelve hasta 24 horarios libres.",
    input_schema: {
      type: "object",
      properties: {
        cedula: { type: "string", description: "Cédula del paciente (necesaria para selectCustomer)" },
        date_DDMMYYYY: {
          type: "string",
          description: 'Opcional. Fecha de inicio en formato DD/MM/YYYY. Si no se da, usa el próximo miércoles.',
        },
      },
      required: ["cedula"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Reserva un slot específico. SOLO usar después de que find_available_slots devolvió slots Y el paciente eligió uno explícitamente. Si devuelve {needs_email:true}, pide el email al paciente y reintenta con el parámetro email.",
    input_schema: {
      type: "object",
      properties: {
        cedula: { type: "string" },
        slot_id: {
          type: "string",
          description: 'El número del slot (basado en 0): "0" para el primero, "1" para el segundo, etc.',
        },
        email: {
          type: "string",
          description: "Email del paciente — solo necesario si Bukeala no lo tiene registrado",
        },
      },
      required: ["cedula", "slot_id"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancela una cita existente por su reservation_code (formato 'item123-456').",
    input_schema: {
      type: "object",
      properties: {
        reservation_code: { type: "string" },
        reason: {
          type: "string",
          description: "Motivo (libre, p.ej. 'paciente no puede asistir')",
        },
      },
      required: ["reservation_code"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Notifica al doctor que esta conversación necesita atención humana. Usar cuando: (1) algo médico urgente, (2) reclamos, (3) no puedes resolver, (4) paciente lo pide. SIEMPRE provee intent + urgency + sugerencia para que el doctor responda más rápido.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Por qué se escala (1 línea breve)" },
        intent: {
          type: "string",
          enum: ["agendar", "cancelar", "consulta_medica", "queja", "informacion_general", "otro"],
          description: "Qué intent detectaste del paciente",
        },
        urgency: {
          type: "string",
          enum: ["alta", "media", "baja"],
          description: "Urgencia: alta=respuesta inmediata (urgencia médica, queja fuerte), media=hoy mismo, baja=puede esperar 1-2 días",
        },
        suggested_response: {
          type: "string",
          description: "Sugerencia de respuesta humana en 1-2 frases para el doctor (opcional pero útil)",
        },
      },
      required: ["reason", "intent", "urgency"],
    },
  },
  {
    name: "request_quote",
    description:
      "Cuando el paciente pide PRECIO, COSTO, COTIZACIÓN o VALOR de un procedimiento, llama esta herramienta. NO des precios tú, ni siquiera rangos — Andrea (encargada de cotizaciones) los maneja con lo personalizado de cada caso. Esta herramienta crea un ticket que Andrea recibe automáticamente.",
    input_schema: {
      type: "object",
      properties: {
        procedure: {
          type: "string",
          description: "El procedimiento que el paciente quiere cotizar (rinoplastia, mamoplastia, abdominoplastia, blefaroplastia, etc.)",
        },
        details: {
          type: "string",
          description: "Cualquier detalle relevante que el paciente haya dado o que tú hayas inferido: edad, antecedentes, si es primera vez, si tiene exámenes previos, urgencia, etc.",
        },
      },
      required: ["procedure"],
    },
  },
];

interface AgentResult {
  finalText: string;
  shouldEscalate: boolean;
  escalateReason?: string;
  escalateIntent?: string;
  escalateUrgency?: string;
  escalateSuggestion?: string;
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: any;
}

export async function runBookingAgent(
  env: Env,
  fromPhone: string,
  inboundText: string,
  channel: MessagingChannel = WHATSAPP_CHANNEL,
): Promise<AgentResult> {
  const history = await loadHistory(env, fromPhone, channel);
  // OPTIMIZACIÓN #3: history reducido de 12 → 8 turnos (ahorra ~30% input tokens
  // sin perder contexto relevante; los turnos > 8 raramente importan para la decisión inmediata)
  const messages: ConversationTurn[] = history.slice(-8).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  messages.push({ role: "user", content: inboundText });

  // OPTIMIZACIÓN #4: Routing Haiku para saludos/info iniciales simples.
  // Si es primer contacto Y el mensaje es un saludo o pregunta genérica sin
  // intención clara de booking → usa Haiku (10x más barato). Para todo lo demás
  // (cédula, fechas, "agendar", "cotizar", etc.) → Sonnet con tool use completo.
  const isSimpleGreeting =
    history.length === 0 &&
    inboundText.length < 80 &&
    /^(hola|buenos|buenas|hi|hello|info|informacion|información|gracias|ok|chao|adios|saludos|hey|qué tal|que tal)\b/i.test(inboundText.trim()) &&
    !/\b(agendar|cita|cotizar|precio|valor|cancelar|reservar|c[eé]dula|\d{6,})\b/i.test(inboundText);
  const initialModel = isSimpleGreeting ? "claude-haiku-4-5" : "claude-sonnet-4-6";

  let escalated = false;
  let escalateReason: string | undefined;
  let escalateIntent: string | undefined;
  let escalateUrgency: string | undefined;
  let escalateSuggestion: string | undefined;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    // Solo el turno 0 puede ser Haiku; si Haiku decidió llamar herramientas
    // (raro pero posible), upgradeamos a Sonnet en los siguientes turnos.
    const modelToUse = loop === 0 ? initialModel : "claude-sonnet-4-6";
    const res = await callClaude(env, messages, modelToUse);
    if (!res) {
      return {
        finalText: "Disculpa, tuve un problema técnico. Te conecto con un humano.",
        shouldEscalate: true,
        escalateReason: "Claude API failure",
      };
    }
    const stopReason = res.stop_reason as string;
    const content = res.content as Array<any>;
    messages.push({ role: "assistant", content });

    if (stopReason === "end_turn") {
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      return {
        finalText: text || "Disculpa, no entendí. ¿Puedes reformular?",
        shouldEscalate: escalated,
        escalateReason,
        escalateIntent,
        escalateUrgency,
        escalateSuggestion,
      };
    }
    if (stopReason !== "tool_use") {
      return {
        finalText: "Disculpa, tuve un problema. Te conecto con un humano.",
        shouldEscalate: true,
        escalateReason: `unexpected stop_reason: ${stopReason}`,
      };
    }

    const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const result = await executeTool(env, fromPhone, block.name, block.input ?? {}, channel);
      if (result.escalated) {
        escalated = true;
        escalateReason = result.escalateReason;
        escalateIntent = result.escalateIntent;
        escalateUrgency = result.escalateUrgency;
        escalateSuggestion = result.escalateSuggestion;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    finalText: "Voy a poner a un humano en contacto contigo. Un momento.",
    shouldEscalate: true,
    escalateReason: "agent loop cap",
    escalateIntent,
    escalateUrgency,
    escalateSuggestion,
  };
}

async function callClaude(env: Env, messages: ConversationTurn[], model: string = "claude-sonnet-4-6"): Promise<any | null> {
  // OPTIMIZACIÓN #1: Prompt caching
  // - system block: marcado con cache_control "ephemeral" (TTL 5 min). El sistema
  //   prompt es estable (mismo para todas las conversaciones), así que se cachea
  //   y se reusa entre turnos y entre pacientes.
  // - tools: el ÚLTIMO tool marcado con cache_control hace que TODOS los tools
  //   se cacheen juntos. Anthropic cobra 1.25x para escribir cache, pero 0.1x
  //   para leerlo (90% descuento). Con 4-6 turnos por conversación + múltiples
  //   conversaciones simultáneas, el ROI es enorme.
  const cachedTools = TOOLS.map((t, i) =>
    i === TOOLS.length - 1
      ? { ...t, cache_control: { type: "ephemeral" } }
      : t
  );
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512, // respuestas WhatsApp cortas (1-2 frases)
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        tools: cachedTools,
        messages,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`[claude-agent] api error ${res.status} model=${model}: ${txt.slice(0, 300)}`);
      return null;
    }
    const data = await res.json<any>();
    // Log cache stats si vienen (útil para verificar que cache funciona)
    const usage = data?.usage;
    if (usage) {
      console.log(
        `[claude-agent] usage model=${model} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`,
      );
    }
    return data;
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
  escalateIntent?: string;
  escalateUrgency?: string;
  escalateSuggestion?: string;
}

interface PatientCtx {
  name: string;
  cedula: string;
  idType: string; // numeric Bukeala code, e.g. "1"
  idTypeChar: string; // letter form, e.g. "C"
  gender: string; // "M" | "F"
  email: string | null;
  phone: string | null;
}

async function executeTool(
  env: Env,
  fromPhone: string,
  name: string,
  input: any,
  channel: MessagingChannel,
): Promise<ToolResult> {
  console.log(`[claude-agent] tool=${name} from=${channel.kvPrefix}:${fromPhone} input=`, JSON.stringify(input).slice(0, 300));

  try {
    if (name === "escalate_to_human") {
      return {
        output: { escalated: true, message: "Humano notificado" },
        escalated: true,
        escalateReason: input.reason,
        escalateIntent: input.intent,
        escalateUrgency: input.urgency,
        escalateSuggestion: input.suggested_response,
      };
    }

    if (name === "find_patient") {
      return await toolFindPatient(env, fromPhone, String(input.cedula ?? ""), channel);
    }
    if (name === "list_patient_bookings") {
      return await toolListBookings(env, String(input.cedula ?? ""));
    }
    if (name === "find_available_slots") {
      return await toolFindSlots(
        env,
        fromPhone,
        String(input.cedula ?? ""),
        input.date_DDMMYYYY ? String(input.date_DDMMYYYY) : "",
        channel,
      );
    }
    if (name === "book_appointment") {
      return await toolBookAppointment(
        env,
        fromPhone,
        String(input.cedula ?? ""),
        String(input.slot_id ?? ""),
        input.email ? String(input.email) : undefined,
        channel,
      );
    }
    if (name === "cancel_appointment") {
      return await toolCancelAppointment(
        env,
        fromPhone,
        String(input.reservation_code ?? ""),
        input.reason ? String(input.reason) : "paciente no puede asistir",
      );
    }
    if (name === "request_quote") {
      return await toolRequestQuote(
        env,
        fromPhone,
        String(input.procedure ?? ""),
        input.details ? String(input.details) : undefined,
        channel,
      );
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

// --------------------------------------------------------------------
// find_patient
// --------------------------------------------------------------------

/**
 * Extrae un primer nombre amigable (Title Case) desde el nombre completo
 * Bukeala. Maneja formatos comunes en Colombia:
 *   - "DUQUE ROPERO DAVID FERNANDO" → "David"
 *   - "Cepeda Sanabria, Andrea Del Pilar" → "Andrea"
 *   - "JUAN PÉREZ" → "Juan" (cuando solo hay 2 palabras, asumimos Apellido Nombre)
 *   - "JUAN" → "Juan" (1 palabra: úsala)
 *
 * Si no puede inferir, devuelve "" — la AI se dirige al paciente sin nombre.
 */
function extractSalutation(fullName: string): string {
  if (!fullName || fullName === "(sin nombre)") return "";
  let first = "";
  if (fullName.includes(",")) {
    // Formato "APELLIDOS, NOMBRES" → primer nombre = primera palabra después de la coma
    first = fullName.split(",")[1]?.trim().split(/\s+/)[0] ?? "";
  } else {
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    // Convención colombiana: 2 apellidos + 1-2 nombres → primer nombre en index 2
    if (parts.length >= 4) first = parts[2];
    else if (parts.length === 3) first = parts[1]; // ambiguo pero razonable (apellido + 2 nombres o 2 apellidos + 1 nombre)
    else if (parts.length === 2) first = parts[1]; // probable "Apellido Nombre"
    else first = parts[0] ?? "";
  }
  if (!first) return "";
  // Title case + manejar tildes y caracteres especiales
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const ID_TYPES_TO_TRY = ["1", "8", "9", "2", "5"];
// Map Bukeala numeric type → letter type used in postBooking
const ID_TYPE_LETTER: Record<string, string> = {
  "1": "C", // Cédula de Ciudadanía
  "8": "T", // Tarjeta de Identidad
  "9": "R", // Registro Civil
  "2": "E", // Cédula de Extranjería
  "5": "P", // Pasaporte
};

async function toolFindPatient(env: Env, fromPhone: string, cedulaRaw: string, channel: MessagingChannel): Promise<ToolResult> {
  const cedula = cedulaRaw.replace(/\D/g, "");
  if (!cedula) return { output: { error: "cedula vacía" } };
  const b = new Bukeala(env);
  try {
    for (const t of ID_TYPES_TO_TRY) {
      try {
        const res = await b.findCustomer(t, cedula);
        const j = await res.json<any>().catch(() => null);
        if (j?.result?.code === "EXISTS") {
          const cust = j?.result?.beanCustomer ?? j?.result ?? {};
          const name = cust.name ?? cust.fullName ?? "(sin nombre)";
          const salutation = extractSalutation(name);
          const ctx: PatientCtx = {
            name,
            cedula,
            idType: t,
            idTypeChar: ID_TYPE_LETTER[t] ?? "C",
            gender: (cust.gender ?? cust.sex ?? "F").toString().toUpperCase().startsWith("M") ? "M" : "F",
            email: cust.email ?? null,
            phone: cust.phone ?? cust.cellPhone ?? null,
          };
          await env.STATE.put(
            `${channel.kvPrefix}:patientCtx:${fromPhone}`,
            JSON.stringify(ctx),
            { expirationTtl: 60 * 60 * 24 }, // 24h: cubre cola pendiente larga
          );
          return {
            output: {
              found: true,
              name,
              salutation, // primer nombre Title Case para que la AI lo use ("Listo Juan, ...")
              identification: cedula,
              doc_type: t,
              email: ctx.email,
              phone: ctx.phone,
            },
          };
        }
      } catch (innerErr) {
        if (innerErr instanceof SessionExpiredError) throw innerErr;
      }
    }
    return { output: { found: false, message: "Paciente no encontrado con ningún tipo de documento" } };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      // Bukeala caído al validar paciente → cola pendiente
      await queuePendingRequest(env, {
        fromPhone,
        type: "info",
        cedula,
        details: `Validar paciente con cédula ${cedula}`,
        channel: channel.kvPrefix,
      });
      return {
        output: {
          queued: true,
          message: "Sistema Bukeala caído. Tu solicitud quedó registrada — el equipo te confirma apenas se habilite.",
        },
        escalated: true,
        escalateReason: "Bukeala session expired — request queued",
      };
    }
    return { output: { error: (e as Error).message } };
  }
}

// --------------------------------------------------------------------
// list_patient_bookings
// --------------------------------------------------------------------

async function toolListBookings(env: Env, cedulaRaw: string): Promise<ToolResult> {
  const cedula = cedulaRaw.replace(/\D/g, "");
  if (!cedula) return { output: { error: "cedula vacía" } };
  const b = new Bukeala(env);
  try {
    // Need to selectCustomer first so /myBookings returns this patient's data
    let foundType: string | null = null;
    for (const t of ID_TYPES_TO_TRY) {
      try {
        const res = await b.findCustomer(t, cedula);
        const j = await res.json<any>().catch(() => null);
        if (j?.result?.code === "EXISTS") {
          foundType = t;
          break;
        }
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e;
      }
    }
    if (!foundType) {
      return { output: { found: false, message: "Paciente no encontrado" } };
    }
    await (await b.selectCustomer(foundType, cedula)).text();
    const html = await (await b.myBookings(false)).text();
    const bookings = parseBookingsFromMyBookings(html);
    if (bookings.length === 0) {
      return { output: { bookings: [], message: "Sin citas pendientes" } };
    }
    return {
      output: {
        bookings: bookings.map((bk) => ({
          reservation_code: bk.reservationCode,
          status: bk.status,
          weekday: bk.weekday,
          date: bk.date,
          time: bk.time,
          component: bk.component,
          plan: bk.plan,
        })),
      },
    };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return {
        output: { error: "session_expired" },
        escalated: true,
        escalateReason: "Bukeala session expired",
      };
    }
    return { output: { error: (e as Error).message } };
  }
}

// --------------------------------------------------------------------
// find_available_slots
// --------------------------------------------------------------------

async function toolFindSlots(
  env: Env,
  fromPhone: string,
  cedulaRaw: string,
  dateRaw: string,
  channel: MessagingChannel,
): Promise<ToolResult> {
  const cedula = cedulaRaw.replace(/\D/g, "");
  // If patient didn't specify a date, default to next Wednesday (Dr. Duque only consults Wed).
  const date = dateRaw ? normalizeDateDDMMYYYY(dateRaw) : nextWednesdayDDMMYYYY();
  if (!cedula || !date) return { output: { error: "cedula o fecha inválida" } };

  const b = new Bukeala(env);
  try {
    // 1) Resolve patient + select customer + REFRESCAR patientCtx (TTL 2h)
    // Esto asegura que book_appointment encuentre los datos del paciente
    // aunque la cola de pendientes haya tardado más de 2h en procesarse.
    let foundType: string | null = null;
    let patientData: any = null;
    for (const t of ID_TYPES_TO_TRY) {
      try {
        const res = await b.findCustomer(t, cedula);
        const j = await res.json<any>().catch(() => null);
        if (j?.result?.code === "EXISTS") {
          foundType = t;
          patientData = j?.result?.beanCustomer ?? j?.result ?? {};
          break;
        }
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e;
      }
    }
    if (!foundType) {
      return { output: { found: false, message: "Paciente no encontrado" } };
    }

    // Guardar/refrescar patientCtx para book_appointment posterior
    const patientCtx: PatientCtx = {
      name: patientData?.name ?? patientData?.fullName ?? "(sin nombre)",
      cedula,
      idType: foundType,
      idTypeChar: ID_TYPE_LETTER[foundType] ?? "C",
      gender: (patientData?.gender ?? patientData?.sex ?? "F").toString().toUpperCase().startsWith("M") ? "M" : "F",
      email: patientData?.email ?? null,
      phone: patientData?.phone ?? patientData?.cellPhone ?? null,
    };
    await env.STATE.put(`${channel.kvPrefix}:patientCtx:${fromPhone}`, JSON.stringify(patientCtx), {
      expirationTtl: 60 * 60 * 24, // 24h: cubre cola pendiente larga
    });

    await (await b.selectCustomer(foundType, cedula)).text();

    // 2) Component (cache global por 7 días — Dr. Duque tiene 1 sola especialidad)
    let component: { id: number; code: string; name: string } | null = null;
    const cachedComp = await env.STATE.get("bukeala:firstComponent");
    if (cachedComp) {
      try { component = JSON.parse(cachedComp); } catch { /* ignore */ }
    }
    if (!component) {
      const cRes = await b.loadComponents();
      const cJson = await cRes.json<any>().catch(() => []);
      const components = Array.isArray(cJson)
        ? cJson
            .map((x: any) => ({
              id: Number(x.id ?? 0),
              code: String(x.code ?? ""),
              name: String(x.description ?? x.name ?? "").trim(),
            }))
            .filter((c) => c.id && c.code && c.name)
        : [];
      if (components.length === 0) {
        return { output: { error: "no_components", message: "No hay especialidades disponibles para este paciente" } };
      }
      component = components[0];
      await env.STATE.put("bukeala:firstComponent", JSON.stringify(component), {
        expirationTtl: 60 * 60 * 24 * 7,
      });
    }

    // 3) Warmup secuencial OBLIGATORIO: changeUserType primero (setea contexto
    // de plan en la sesión Java). Después los otros 3 en PARALELO (no
    // dependen entre ellos, ahorra ~1.5-2.5s vs secuencial).
    try {
      await (await b.changeUserTypeSelected("309", "")).text();
      await Promise.all([
        b.loadBranches("", [component.code]).then((r) => r.text()),
        b.getAvailablePlans().then((r) => r.text()),
        b.loadAreaHints(component.code).then((r) => r.text()),
      ]);
    } catch (e) {
      console.log("[agent] warmup error (ignored):", (e as Error).message);
    }
    // doPage SECUENCIAL antes de doSearch (doSearch lee contexto que doPage setea)
    await (await b.findAvailabilityDoPage({
      componentCodes: [component.code],
      startDateStr: date,
    })).text();

    // 4) Search
    const searchRes = await b.doSearch({ startDateStr: date, componentCodes: [component.code] });
    const searchJson = await searchRes.json<any>().catch(() => null);
    const year = (() => {
      const m = date.match(/\/(\d{4})$/);
      return m ? Number(m[1]) : new Date().getFullYear();
    })();
    const slots = parseSlots(searchJson, { componentCode: component.code, year });

    if (slots.length === 0) {
      const next = searchJson?.nextDayForSearchFormatted as string | undefined;
      return {
        output: {
          slots: [],
          message: searchJson?.emptyMessage
            ? String(searchJson.emptyMessage).replace(/<[^>]+>/g, "")
            : "Sin slots en la fecha pedida",
          next_date_suggestion: next ?? null,
        },
      };
    }

    // 5) Persist slots + booking context for later book_appointment
    await env.STATE.put(`${channel.kvPrefix}:slots:${fromPhone}`, JSON.stringify(slots), {
      expirationTtl: 60 * 30,
    });
    await env.STATE.put(
      `${channel.kvPrefix}:slotCtx:${fromPhone}`,
      JSON.stringify({ cedula, foundType, componentCode: component.code, componentId: component.id, componentName: component.name }),
      { expirationTtl: 60 * 30 },
    );

    // 6) Format slots for Claude — include index so the AI can reference them
    const formatted = slots.map((s, i) => ({
      id: String(i),
      label: `${s.label} (${secondsToHHMM12h(s.timeInSeconds)})`,
      date: s.dateFormatted,
      time_24h: secondsToHHMM(s.timeInSeconds),
      time_12h: secondsToHHMM12h(s.timeInSeconds),
    }));
    // Salutation primer-nombre para que la AI se dirija al paciente cómodamente
    const patientName = patientCtx.name;
    const salutation = extractSalutation(patientName);

    return {
      output: {
        slots: formatted,
        component: component.name,
        patient_name: patientName,
        salutation, // úsalo así: "Listo Juan, para Mié 13/05 tengo: 1) ..."
        message: `Hay ${slots.length} cupos disponibles. Para reservar, llama book_appointment con cedula=${cedula} y slot_id="0" (o "1", "2"...).`,
      },
    };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      // Bukeala caído → guardar solicitud pendiente y avisar al doctor
      const patientCtxRaw = await env.STATE.get(`${channel.kvPrefix}:patientCtx:${fromPhone}`);
      const patient: PatientCtx | null = patientCtxRaw ? JSON.parse(patientCtxRaw) : null;
      await queuePendingRequest(env, {
        fromPhone,
        type: "book",
        cedula,
        patientName: patient?.name,
        requestedDate: date,
        details: `Buscar cupos para ${date}`,
        channel: channel.kvPrefix,
      });
      return {
        output: {
          queued: true,
          message: "Sistema Bukeala caído — solicitud quedó registrada. Avisaré al equipo para que te confirmen apenas se habilite.",
        },
        escalated: true,
        escalateReason: "Bukeala session expired — request queued",
      };
    }
    return { output: { error: (e as Error).message } };
  }
}

// --------------------------------------------------------------------
// book_appointment
// --------------------------------------------------------------------

async function toolBookAppointment(
  env: Env,
  fromPhone: string,
  cedulaRaw: string,
  slotIdRaw: string,
  emailParam: string | undefined,
  channel: MessagingChannel,
): Promise<ToolResult> {
  const cedula = cedulaRaw.replace(/\D/g, "");
  const slotIdx = parseInt(slotIdRaw, 10);
  if (!cedula) return { output: { error: "cedula vacía" } };
  if (Number.isNaN(slotIdx) || slotIdx < 0) return { output: { error: "slot_id inválido" } };

  // Load slots + ctx from KV (saved by find_available_slots)
  const slotsRaw = await env.STATE.get(`${channel.kvPrefix}:slots:${fromPhone}`);
  const ctxRaw = await env.STATE.get(`${channel.kvPrefix}:slotCtx:${fromPhone}`);
  if (!slotsRaw || !ctxRaw) {
    return {
      output: {
        error: "no_slots_in_memory",
        message: "Primero llama find_available_slots para cargar los cupos.",
      },
    };
  }
  const slots = JSON.parse(slotsRaw) as Slot[];
  const ctx = JSON.parse(ctxRaw) as { cedula: string; foundType: string; componentCode: string; componentId: number; componentName: string };
  const slot = slots[slotIdx];
  if (!slot) return { output: { error: "slot_id fuera de rango", available: slots.length } };
  if (ctx.cedula !== cedula) {
    return {
      output: { error: "cedula_mismatch", message: "La cédula no coincide con la búsqueda anterior. Llama find_available_slots de nuevo." },
    };
  }

  const patientCtxRaw = await env.STATE.get(`${channel.kvPrefix}:patientCtx:${fromPhone}`);
  const patient: PatientCtx | null = patientCtxRaw ? JSON.parse(patientCtxRaw) : null;
  if (!patient) {
    return {
      output: { error: "patient_not_loaded", message: "Llama find_patient primero." },
    };
  }

  const b = new Bukeala(env);
  try {
    // 1) assignBooking → fetch the confirmation HTML, parse pre-filled email/phone
    const searchParamsJson = JSON.stringify({
      branchId: Number(env.BRANCH_ID),
      jsonComponentCodes: JSON.stringify([ctx.componentCode]),
      startDateStr: ddmmyyyy(new Date()),
      areaPattern: "",
      resultGrouped: false,
      resultShow: 0,
      followedBookingsCount: 1,
      isMultipleComponent: false,
      attentionType: "P",
      isOverBooking: "false",
      minQuantitySessions: 1,
      maxQuantitySessions: 1,
      branchName: "",
      jsonComponents: JSON.stringify([{ code: ctx.componentCode, description: ctx.componentName }]),
    });
    const bookingsDataJsonForAssign = JSON.stringify([
      {
        bookingComponentId: slot.bookingComponentId,
        areaId: slot.areaId,
        dateFormatted: slot.dateFormatted,
        timeInSeconds: slot.timeInSeconds,
        timeInBetween: "",
      },
    ]);
    const assignRes = await b.assignBooking({
      branchId: env.BRANCH_ID,
      customerIdentification: cedula,
      customerIdentificationType: patient.idTypeChar,
      customerGender: patient.gender,
      bookingsDataJson: bookingsDataJsonForAssign,
      multipleComponentId: "",
      searchParamsJson,
      isReassignBooking: "false",
      reassignOriginalBookingId: "",
      cancelationReasonId: "",
      cancelationComment: "",
      notificationPendingBooking: "",
      groupSelect: "false",
      followedBookingsCount: "",
      overBooking: "false",
      authorizationCode: "",
    });
    const assignHtml = await assignRes.text();
    const contact = parseContactFromAssign(assignHtml);

    // Determine final email/phone
    const email = emailParam || contact.email || patient.email || "";
    const phone = contact.phone || patient.phone || normalizePhoneCO(fromPhone);

    if (!email) {
      return {
        output: {
          needs_email: true,
          message: "El paciente no tiene email registrado en Bukeala. Pide el email y reintenta book_appointment con el parámetro email.",
        },
      };
    }

    // 2) validateBookingDate
    await (await b.validateBookingDate({
      bookingComponentId: slot.bookingComponentId,
      startDateStr: slot.dateFormatted,
      bookingTime: slot.timeInSeconds,
      areaId: slot.areaId,
    })).text();

    // 3) addPrebooking
    await (await b.addPrebooking({
      bookingComponentId: slot.bookingComponentId,
      timeInSeconds: slot.timeInSeconds,
      startDateStr: slot.dateFormatted,
      areaId: slot.areaId,
    })).text();

    // 4) postBooking
    const bookingsDataJson = JSON.stringify([
      {
        bookingComponentId: slot.bookingComponentId,
        bookingComponentCode: slot.bookingComponentCode,
        branchCode: slot.branchCode,
        unidadOrganizativa: slot.branchCode,
        preparationMessages: [],
        areaId: slot.areaId,
        areaCode: slot.areaCode,
        comment: "200",
        dateFormatted: slot.dateFormatted,
        timeInSeconds: slot.timeInSeconds,
        attachmentUrls: null,
        duration: slot.duration,
      },
    ]);
    const payload = {
      bookingsDataJson,
      branchId: env.BRANCH_ID,
      name: patient.name,
      customerIdentification: cedula,
      customerIdentificationType: patient.idTypeChar,
      customerGender: patient.gender,
      unidadOrganizativa: slot.branchCode,
      branchCode: slot.branchCode,
      email,
      comment: "Agendado por asistente AI vía WhatsApp",
      phoneCountryCode: "mx", // backend acepta 'mx' por bug histórico
      cellPhone: phone
        ? { id: null, phoneNumber: phone, countryCode: "co", dialCode: "+57" }
        : null,
      landPhone: null,
      overBooking: false,
      followedBookingsCount: 1,
      isReassign: false,
      cancelationComment: "",
      presential: "true",
      multipleComponentIdStr: "",
    };

    const postRes = await b.postBooking(payload);
    const rawText = await postRes.text();
    const json = (() => { try { return JSON.parse(rawText); } catch { return null; } })();
    console.log(`[agent] postBooking status=${postRes.status} body=${rawText.slice(0, 400)}`);

    if (json?.result?.code === "SUCCESS") {
      const r = json.bookingResults?.[0];
      const reservationCode = r?.reservationCode ?? "(?)";
      const dateStr = r?.bookingDateStr ?? slot.dateFormatted;
      const timeStr = r?.bookingTimeStr ?? secondsToHHMM12h(slot.timeInSeconds);
      const dayStr = r?.dayOfWeekInLetters ?? "";

      // Send confirmation template — solo si el canal soporta templates (WA).
      // En Instagram no hay templates, así que el confirmation va por DM
      // como texto libre (se cubre por el finalText que la AI compone).
      if (channel.supportsTemplates && phone) {
        try {
          await sendAppointmentConfirmation(
            env,
            phone,
            patient.name,
            `${dayStr} ${dateStr}`.trim(),
            timeStr,
            "Calle 80 # 10-43, Cons 506, Bogotá",
          );
        } catch (e) {
          console.log("[agent] WA confirmation failed:", (e as Error).message);
        }
      }

      // Notify Telegram (the WhatsApp webhook will also send a notification, but
      // this one includes the booking specifics + cancel button for safety net)
      try {
        const recipients = await getAllRecipients(env);
        const tgText =
          `🤖✅ <b>Cita agendada por AI</b>\n\n` +
          `Paciente: <b>${escapeHtml(patient.name)}</b>\n` +
          `Cédula: <code>${cedula}</code>\n` +
          `Cuándo: ${escapeHtml(dayStr)} ${escapeHtml(dateStr)} ${escapeHtml(timeStr)}\n` +
          `Especialidad: ${escapeHtml(ctx.componentName)}\n` +
          `WhatsApp: <code>${escapeHtml(fromPhone)}</code>\n` +
          `Email: ${escapeHtml(email)}\n` +
          `Código: <code>${escapeHtml(reservationCode)}</code>`;
        for (const chatId of recipients) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: tgText,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "❌ Cancelar esta cita", callback_data: `cancel:${reservationCode}` },
                ]],
              },
            }),
          });
        }
      } catch (e) {
        console.log("[agent] Telegram notify failed:", (e as Error).message);
      }

      // Clear cached slots so a new search has fresh data next time
      await env.STATE.delete(`${channel.kvPrefix}:slots:${fromPhone}`);
      await env.STATE.delete(`${channel.kvPrefix}:slotCtx:${fromPhone}`);

      return {
        output: {
          success: true,
          reservation_code: reservationCode,
          when: `${dayStr} ${dateStr} ${timeStr}`.trim(),
          message: `Cita confirmada para ${dayStr} ${dateStr} a las ${timeStr}. Código ${reservationCode}.`,
        },
      };
    }

    const errMsg = json?.messages?.[0]?.description ?? json?.result?.description ?? `HTTP ${postRes.status}`;
    return {
      output: {
        success: false,
        error: "booking_failed",
        message: String(errMsg).replace(/<[^>]+>/g, "").slice(0, 200),
      },
      escalated: true,
      escalateReason: `postBooking failed: ${String(errMsg).slice(0, 100)}`,
    };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      // Bukeala caído justo cuando íbamos a agendar → cola pendiente
      await queuePendingRequest(env, {
        fromPhone,
        type: "book",
        cedula,
        patientName: patient.name,
        requestedDate: slot.dateFormatted,
        details: `Confirmar cita ${slot.dateFormatted} ${secondsToHHMM12h(slot.timeInSeconds)}`,
        channel: channel.kvPrefix,
      });
      return {
        output: {
          queued: true,
          message: "Sistema Bukeala caído justo al confirmar — solicitud quedó registrada. El equipo te confirma apenas se habilite.",
        },
        escalated: true,
        escalateReason: "Bukeala session expired — booking queued",
      };
    }
    return {
      output: { error: (e as Error).message },
      escalated: true,
      escalateReason: `book_appointment threw: ${(e as Error).message.slice(0, 100)}`,
    };
  }
}

// --------------------------------------------------------------------
// request_quote — crea ticket para Andrea
// --------------------------------------------------------------------
async function toolRequestQuote(
  env: Env,
  fromPhone: string,
  procedure: string,
  details: string | undefined,
  channel: MessagingChannel,
): Promise<ToolResult> {
  if (!procedure) return { output: { error: "procedure requerido" } };

  // Recuperar contexto del paciente si lo tenemos
  const patientCtxRaw = await env.STATE.get(`${channel.kvPrefix}:patientCtx:${fromPhone}`);
  const patient: PatientCtx | null = patientCtxRaw ? JSON.parse(patientCtxRaw) : null;

  // Nombre del contacto (de {channel}:contact:*)
  const contactRaw = await env.STATE.get(`${channel.kvPrefix}:contact:${fromPhone}`);
  let contactName = patient?.name ?? "(sin nombre)";
  if (contactRaw) {
    try {
      const c = JSON.parse(contactRaw);
      if (c.name && c.name !== "Desconocido") contactName = c.name;
    } catch { /* ignore */ }
  }

  await createQuoteTicket(env, {
    fromPhone,
    patientName: contactName,
    cedula: patient?.cedula,
    source: channel.kvPrefix === "ig" ? "wa_ai" : "wa_ai", // unified source for now
    procedure,
    details,
    patientMessage: details,
  });

  return {
    output: {
      success: true,
      message: "Ticket de cotización creado. Andrea ya recibió la solicitud y te responderá pronto con el precio personalizado.",
      ai_should_say:
        "Voy a pasarte con Andrea, mi encargada de cotizaciones, que te arma el precio personalizado para tu caso. En un momento te escribe por aquí mismo.",
    },
  };
}

// --------------------------------------------------------------------
// cancel_appointment
// --------------------------------------------------------------------

async function toolCancelAppointment(
  env: Env,
  fromPhone: string,
  reservationCode: string,
  reason: string,
): Promise<ToolResult> {
  if (!reservationCode) return { output: { error: "reservation_code vacío" } };
  const b = new Bukeala(env);
  try {
    // Default reason: paciente_no_puede_asistir (ID 1 in Bukeala — adjust if needed).
    // TODO: fetch real cancelationReasons and match by description.
    const res = await b.cancelBooking({
      reservationCode,
      cancelReasonId: "1",
      cancelationComment: `Cancelado por AI vía WhatsApp: ${reason.slice(0, 100)}`,
    });
    const json = await res.json<any>().catch(() => null);
    if (json?.result?.code === "SUCCESS") {
      // Notify Telegram
      try {
        const recipients = await getAllRecipients(env);
        const tgText =
          `🤖❌ <b>Cita cancelada por AI</b>\n` +
          `Código: <code>${escapeHtml(reservationCode)}</code>\n` +
          `WhatsApp: <code>${escapeHtml(fromPhone)}</code>\n` +
          `Motivo: ${escapeHtml(reason)}`;
        for (const chatId of recipients) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: tgText, parse_mode: "HTML" }),
          });
        }
      } catch (e) {
        console.log("[agent] Telegram cancel-notify failed:", (e as Error).message);
      }

      // Try to send the patient a WA template (best-effort, needs date/time which we don't have here)
      // The agent prompt should have already shown the date/time; we skip the template to avoid wrong info.

      return {
        output: { success: true, message: `Cita ${reservationCode} cancelada.` },
      };
    }
    const msg = json?.result?.description ?? json?.messages?.[0]?.description ?? "Error desconocido";
    return {
      output: { success: false, error: String(msg).replace(/<[^>]+>/g, "") },
      escalated: true,
      escalateReason: `cancelBooking failed: ${String(msg).slice(0, 100)}`,
    };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return {
        output: { error: "session_expired" },
        escalated: true,
        escalateReason: "Bukeala session expired",
      };
    }
    return {
      output: { error: (e as Error).message },
      escalated: true,
      escalateReason: `cancel_appointment threw: ${(e as Error).message.slice(0, 100)}`,
    };
  }
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

async function loadHistory(
  env: Env,
  fromPhone: string,
  channel: MessagingChannel,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const raw = await env.STATE.get(`${channel.kvPrefix}:history:${fromPhone}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t) => typeof t?.content === "string" && (t.role === "user" || t.role === "assistant"),
    );
  } catch {
    return [];
  }
}

/** Accept "14/05", "14-05", "14/05/2026", "14-05-2026" → "DD/MM/YYYY". */
function normalizeDateDDMMYYYY(raw: string): string | null {
  const cleaned = raw.trim().replace(/-/g, "/");
  const m = cleaned.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  let yyyy: string;
  if (m[3]) {
    yyyy = m[3].length === 2 ? "20" + m[3] : m[3];
  } else {
    yyyy = String(new Date().getFullYear());
  }
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Compute the next Wednesday in Bogota timezone, returned as DD/MM/YYYY.
 * If today IS Wednesday, returns today (so an early-morning patient can still
 * book a same-day slot in the doctor's afternoon window).
 */
function nextWednesdayDDMMYYYY(): string {
  // Get current date in Bogota (UTC-5)
  const now = new Date();
  const bogota = new Date(now.getTime() + (-5 * 60 - now.getTimezoneOffset()) * 60 * 1000);
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const dow = bogota.getUTCDay();
  const daysToWed = dow === 3 ? 0 : (3 - dow + 7) % 7;
  const target = new Date(bogota);
  target.setUTCDate(bogota.getUTCDate() + daysToWed);
  const dd = String(target.getUTCDate()).padStart(2, "0");
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = target.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// --------------------------------------------------------------------
// Pending requests queue (when Bukeala is down)
// --------------------------------------------------------------------

interface PendingRequest {
  fromPhone: string;
  type: "book" | "cancel" | "info";
  cedula?: string;
  patientName?: string;
  requestedDate?: string;
  details: string;
  channel?: "wa" | "ig"; // canal de origen — default "wa" (legacy)
  queuedAt: number;
  queuedAtISO: string;
}

/**
 * Save a request to the pending queue and notify the doctor on Telegram.
 * Used when Bukeala session is expired so the patient knows we got their
 * request and the doctor can act once Bukeala recovers.
 *
 * Dedups within last 60 min by fromPhone+cedula+type so retries on a still-
 * down Bukeala don't spam the queue.
 */
async function queuePendingRequest(
  env: Env,
  req: Omit<PendingRequest, "queuedAt" | "queuedAtISO">,
): Promise<void> {
  const key = "wa:pending:list";
  const raw = await env.STATE.get(key);
  const list: PendingRequest[] = raw ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : [];

  // Dedup: skip if same phone+cedula+type was queued in the last 60 minutes
  const cutoff = Date.now() - 60 * 60 * 1000;
  const isDuplicate = list.some(
    (p) =>
      p.fromPhone === req.fromPhone &&
      (p.cedula ?? "") === (req.cedula ?? "") &&
      p.type === req.type &&
      p.queuedAt > cutoff,
  );
  if (isDuplicate) {
    console.log(`[queue] dedup hit, skipping for ${req.fromPhone}`);
    return;
  }

  const entry: PendingRequest = {
    ...req,
    queuedAt: Date.now(),
    queuedAtISO: new Date().toISOString(),
  };
  list.push(entry);
  await env.STATE.put(key, JSON.stringify(list.slice(-50)), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  // Auto-trigger refresh inmediato (no esperar al cron de keepalive). Throttle
  // 3 min para no saturar al watcher si llegan varios pacientes simultáneos.
  try {
    const lastAt = await env.STATE.get("keepalive:autoRefreshAt");
    const now = Date.now();
    const shouldRefresh = !lastAt || now - parseInt(lastAt, 10) > 3 * 60 * 1000;
    if (shouldRefresh) {
      await requestRefresh(env, "wa-incoming-session-expired");
      await env.STATE.put("keepalive:autoRefreshAt", String(now), { expirationTtl: 60 * 60 });
      console.log("[queue] auto-refresh triggered (on-demand from WA inbound)");
    }
  } catch (e) {
    console.log("[queue] auto-refresh trigger failed:", (e as Error).message);
  }

  // Notify doctor + secretaries immediately (only when actually queued, not on dedup)
  try {
    const recipients = await getAllRecipients(env);
    const tgText =
      `⏳ <b>Solicitud pendiente — Bukeala caído</b>\n\n` +
      `Paciente: <b>${escapeHtml(req.patientName ?? "(sin nombre)")}</b>\n` +
      `Cédula: <code>${escapeHtml(req.cedula ?? "?")}</code>\n` +
      `WhatsApp: <code>${escapeHtml(req.fromPhone)}</code>\n` +
      `Solicita: ${escapeHtml(req.details)}\n` +
      (req.requestedDate ? `Fecha pedida: ${escapeHtml(req.requestedDate)}\n` : "") +
      `\n<i>Renueva sesión Bukeala (/sesion_renew). Apenas se renueve, el bot procesa la cola automáticamente y le manda WhatsApp al paciente con sus cupos.</i>`;
    for (const chatId of recipients) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: tgText, parse_mode: "HTML" }),
      });
    }
  } catch (e) {
    console.log("[agent] queue Telegram notify failed:", (e as Error).message);
  }
}

/**
 * Auto-process the pending queue. Called when:
 *   - Session is captured (handleCapture)
 *   - Native Host reports a successful refresh (handleNativeHostEvent type=ok)
 *   - Refresh-on-demand completes (handleRefreshComplete)
 *   - keepAlive cron pings successfully and queue is non-empty
 *   - Doctor manually triggers /wa_process_pending
 *
 * For each pending entry, we retry the Bukeala flow. On success, we WhatsApp
 * the patient with their slots and append the message to their conversation
 * history so when they reply with a number, the AI booking agent has context.
 *
 * Returns the count of patients notified and how many remain in queue.
 */
export async function processPendingRequests(
  env: Env,
): Promise<{ processed: number; remaining: number; details: string[] }> {
  const pending = await loadPendingRequests(env);
  if (pending.length === 0) return { processed: 0, remaining: 0, details: [] };

  console.log(`[pending] processing ${pending.length} requests`);
  // Atomically take ownership: clear the queue, re-add only what still fails
  await env.STATE.delete("wa:pending:list");

  // Dedup por fromPhone: si hay múltiples tickets del mismo paciente, preferir
  // "book" (más completo) sobre "info". Esto evita mandar 2 mensajes seguidos
  // ("aquí están los cupos" + "sistema disponible, en qué te ayudo").
  const byPhone = new Map<string, PendingRequest>();
  for (const p of pending) {
    const existing = byPhone.get(p.fromPhone);
    if (!existing) {
      byPhone.set(p.fromPhone, p);
      continue;
    }
    // Priority: book > cancel > info
    const rank = { book: 3, cancel: 2, info: 1 } as Record<PendingRequest["type"], number>;
    if ((rank[p.type] ?? 0) > (rank[existing.type] ?? 0)) {
      byPhone.set(p.fromPhone, p);
    }
  }
  const dedupedPending = Array.from(byPhone.values());
  if (dedupedPending.length < pending.length) {
    console.log(`[pending] deduped ${pending.length} → ${dedupedPending.length} (1 ticket por paciente)`);
  }

  let processed = 0;
  const stillFailed: PendingRequest[] = [];
  const details: string[] = [];

  for (const p of dedupedPending) {
    // Determinar canal del ticket (default WA para tickets legacy sin channel)
    const ch: MessagingChannel = p.channel === "ig" ? INSTAGRAM_CHANNEL : WHATSAPP_CHANNEL;
    try {
      if (p.type === "book" && p.cedula) {
        const date = p.requestedDate || nextWednesdayDDMMYYYY();
        const r = await toolFindSlots(env, p.fromPhone, p.cedula, date, ch);
        // toolFindSlots calls queuePendingRequest internally on session_expired,
        // but with dedup-60min that re-queue is idempotent. We track via the
        // {queued:true} marker in the response.
        if (r.output?.queued) {
          stillFailed.push(p);
          details.push(`${p.patientName ?? p.fromPhone}: Bukeala aún caído`);
          continue;
        }
        const slots = r.output?.slots as Array<{ id: string; label: string; time_12h: string }> | undefined;
        if (slots && slots.length > 0) {
          const top = slots.slice(0, 6);
          const list = top.map((s, i) => `${i + 1}) ${s.label}`).join("\n");
          const firstName = p.patientName ? p.patientName.split(/[, ]/)[0] : "";
          const greeting = firstName ? `¡Hola ${firstName}!` : "¡Hola!";
          const message =
            `${greeting} ✅ Ya está listo el sistema.\n\n` +
            `Estos son los cupos disponibles para ${date}:\n\n${list}\n\n` +
            `Responde con el número del que prefieras (1, 2, 3...).`;
          await ch.sendText(env, p.fromPhone, message);
          await appendHistory(env, p.fromPhone, "assistant", message, ch.kvPrefix);
          processed++;
          details.push(`${p.patientName ?? p.fromPhone} [${ch.label}]: notificado con ${slots.length} cupos`);
        } else {
          const next = r.output?.next_date_suggestion;
          const firstName = p.patientName ? p.patientName.split(/[, ]/)[0] : "";
          const greeting = firstName ? `¡Hola ${firstName}!` : "¡Hola!";
          const msg = next
            ? `${greeting} El sistema ya está disponible. No hay cupos para ${date}, pero el siguiente disponible es ${next}. ¿Lo tomamos?`
            : `${greeting} El sistema ya está disponible, pero no hay cupos para ${date}. ¿Probamos otra fecha?`;
          await ch.sendText(env, p.fromPhone, msg);
          await appendHistory(env, p.fromPhone, "assistant", msg, ch.kvPrefix);
          processed++;
          details.push(`${p.patientName ?? p.fromPhone} [${ch.label}]: sin cupos en ${date}, propuse alternativa`);
        }
      } else if (p.type === "info" && p.cedula) {
        const r = await toolFindPatient(env, p.fromPhone, p.cedula, ch);
        if (r.output?.queued) {
          stillFailed.push(p);
          details.push(`${p.patientName ?? p.fromPhone}: Bukeala aún caído`);
          continue;
        }
        const found = r.output?.found;
        const firstName = (r.output?.name as string | undefined)?.split(/[, ]/)[0];
        const greeting = found && firstName
          ? `¡Hola ${firstName}! ✅ Sistema disponible. ¿En qué te ayudo? (agendar, consultar tu cita, cancelar...)`
          : `¡Hola! El sistema ya está disponible, pero no encontré tu cédula. ¿Me la confirmas sin puntos?`;
        await ch.sendText(env, p.fromPhone, greeting);
        await appendHistory(env, p.fromPhone, "assistant", greeting, ch.kvPrefix);
        processed++;
        details.push(`${p.patientName ?? p.fromPhone} [${ch.label}]: notificado (info)`);
      } else {
        // Other types (cancel) — leave for human to handle
        stillFailed.push(p);
        details.push(`${p.patientName ?? p.fromPhone}: tipo ${p.type} requiere humano`);
      }
    } catch (e) {
      console.log(`[pending] retry failed for ${p.fromPhone}: ${(e as Error).message}`);
      stillFailed.push(p);
      details.push(`${p.patientName ?? p.fromPhone}: error ${(e as Error).message.slice(0, 60)}`);
    }
  }

  // Re-save what's still pending
  if (stillFailed.length > 0) {
    await env.STATE.put("wa:pending:list", JSON.stringify(stillFailed.slice(-50)), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  }

  // Notify doctor of processing result (only if anything happened)
  if (processed > 0 || stillFailed.length > 0) {
    try {
      const recipients = await getAllRecipients(env);
      const tgText =
        `🔄 <b>Cola pendiente procesada</b>\n` +
        `✅ Pacientes notificados: ${processed}\n` +
        (stillFailed.length > 0 ? `⏳ Aún en cola: ${stillFailed.length}\n` : "") +
        (details.length > 0 ? `\n${details.slice(0, 8).map((d) => "• " + escapeHtml(d)).join("\n")}` : "");
      for (const chatId of recipients) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: tgText, parse_mode: "HTML" }),
        });
      }
    } catch (e) {
      console.log("[pending] result notify failed:", (e as Error).message);
    }
  }

  return { processed, remaining: stillFailed.length, details };
}

/** Read the current pending queue (for /wa_pending command). */
export async function loadPendingRequests(env: Env): Promise<PendingRequest[]> {
  const raw = await env.STATE.get("wa:pending:list");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Clear the pending queue (after doctor processes them). */
export async function clearPendingRequests(env: Env): Promise<void> {
  await env.STATE.delete("wa:pending:list");
}

function normalizePhoneCO(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length === 12) return digits.slice(2);
  if (digits.length === 10) return digits;
  return digits;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
