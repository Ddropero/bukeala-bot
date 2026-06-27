/**
 * BukealaMcp — servidor MCP (Model Context Protocol) para el sistema de
 * agendamiento del Dr. Duque. Expone como herramientas las mismas operaciones
 * que los comandos de Telegram, reutilizando los handlers ya probados, para
 * controlar la agenda hablando natural con Claude (Desktop / móvil / web).
 *
 * Transporte: Streamable HTTP en /mcp (servido por McpAgent.serve).
 * Auth: OAuth (ver ../mcp/authorize.ts + OAuthProvider en index.ts). El usuario
 * autenticado llega en this.props.
 *
 * Seguridad: el cliente Claude pide aprobación al usuario antes de cada tool
 * que modifica algo (abrir/cancelar/bloquear), así que el acceso es completo
 * pero con confirmación humana por acción.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { sendText, sendHelloWorld, normalizeColombianPhone } from "../whatsapp";
import { requestRefresh } from "../handlers/nativeHostEvent";
import { loadSession } from "../kv";
import { handleAbrirAgenda } from "../commands/abrirAgenda";
import { handleCancelarAgenda } from "../commands/cancelarAgenda";
import { handleBloquearDia } from "../commands/bloquearDia";

const AREA_ID = 1074;
const COLOMBIA_OFFSET_MIN = -5 * 60;

type Props = { user?: string };

/** Texto plano desde HTML simple (los handlers devuelven HTML de Telegram). */
function htmlToText(s: string): string {
  return s
    .replace(/<\/?(b|i|code|pre)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** "hoy" | "manana" | "DD/MM/YYYY" → DD-MM-YYYY (con guiones, zona Bogotá). */
function resolveDateDashed(input: string): string | null {
  const t = (input || "").trim().toLowerCase();
  const now = new Date();
  const bog = new Date(now.getTime() + COLOMBIA_OFFSET_MIN * 60 * 1000);
  if (t === "hoy" || t === "" ) {
    return `${pad2(bog.getUTCDate())}-${pad2(bog.getUTCMonth() + 1)}-${bog.getUTCFullYear()}`;
  }
  if (t === "manana" || t === "mañana") {
    bog.setUTCDate(bog.getUTCDate() + 1);
    return `${pad2(bog.getUTCDate())}-${pad2(bog.getUTCMonth() + 1)}-${bog.getUTCFullYear()}`;
  }
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${pad2(+m[1])}-${pad2(+m[2])}-${m[3]}`;
  return null;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export class BukealaMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "bukeala-agenda", version: "1.0.0" });

  async init() {
    const env = this.env;

    // Tras un handler que devuelve needsRenew, despierta la sesión Bukeala.
    const maybeWake = async (needsRenew?: boolean): Promise<string> => {
      if (!needsRenew) return "";
      try {
        await requestRefresh(env, "mcp");
        return "\n\n(Desperté la sesión de Bukeala; reintenta en ~1-2 min.)";
      } catch { return ""; }
    };

    // ---- LECTURA ----

    this.server.tool(
      "ver_agenda",
      "Muestra las citas de un día en la agenda del Dr. Duque. Acepta 'hoy', 'manana' o una fecha DD/MM/YYYY.",
      { fecha: z.string().describe("'hoy', 'manana' o DD/MM/YYYY") },
      async ({ fecha }) => {
        const dashed = resolveDateDashed(fecha);
        if (!dashed) return textResult(`Fecha no válida: "${fecha}". Usa 'hoy', 'manana' o DD/MM/YYYY.`);
        const b = new Bukeala(env);
        try {
          const res = await b.getAgenda(dashed, AREA_ID, false);
          const j = await res.json<any>().catch(() => null);
          const bookings: any[] = j?.areas?.[0]?.bookings ?? [];
          const active = bookings.filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime);
          if (active.length === 0) return textResult(`No hay citas para el ${dashed.replace(/-/g, "/")}.`);
          const lines = active.map((bk) => {
            const phone = bk.cellPhone?.phoneNumber ?? bk.cellPhone ?? bk.phone ?? "";
            const status = bk.stateDescription ?? bk.stateCode ?? "";
            return `• ${bk.startHourFormatted ?? ""} — ${bk.name ?? "Paciente"}${phone ? ` (${phone})` : ""} [${status}]`;
          });
          return textResult(`Agenda ${dashed.replace(/-/g, "/")} — ${active.length} cita(s):\n${lines.join("\n")}`);
        } catch (e) {
          if (e instanceof SessionExpiredError) return textResult("Sesión Bukeala caída." + (await maybeWake(true)));
          return textResult(`Error: ${(e as Error).message}`);
        }
      },
    );

    this.server.tool(
      "listar_agendas",
      "Lista las agendas (calendarios) abiertas en Bukeala de ambos perfiles (niños y adultos), con su ID para poder cancelarlas.",
      {},
      async () => {
        const r = await handleCancelarAgenda(env, "");
        return textResult(htmlToText(r.reply) + (await maybeWake(r.needsRenew)));
      },
    );

    this.server.tool(
      "buscar_paciente",
      "Busca un paciente en Bukeala por número de cédula. Devuelve nombre, teléfono y email si existe.",
      { cedula: z.string().describe("Número de documento, solo dígitos") },
      async ({ cedula }) => {
        const id = (cedula || "").replace(/\D/g, "");
        if (!id) return textResult("Cédula inválida.");
        const b = new Bukeala(env);
        const tries = ["1", "8", "9", "2", "5"];
        try {
          for (const idType of tries) {
            const res = await b.findCustomer(idType, id);
            const j = await res.json<any>().catch(() => null);
            if (j?.result?.code === "EXISTS") {
              const c = j?.result?.beanCustomer ?? j?.result ?? {};
              const name = c.name ?? c.fullName ?? "(sin nombre)";
              const phone = c.phone ?? c.cellPhone ?? "";
              const email = c.email ?? "";
              return textResult(`Paciente ${id}:\nNombre: ${name}\nTel: ${phone || "—"}\nEmail: ${email || "—"}`);
            }
          }
          return textResult(`No encontré paciente con cédula ${id}.`);
        } catch (e) {
          if (e instanceof SessionExpiredError) return textResult("Sesión Bukeala caída." + (await maybeWake(true)));
          return textResult(`Error: ${(e as Error).message}`);
        }
      },
    );

    // ---- SALUD / MONITOR ----

    this.server.tool(
      "estado_sistema",
      "Reporte de salud del sistema: estado de la sesión Bukeala, últimas renovaciones (TGC vs captcha), errores recientes y actividad de la VM renovadora.",
      {},
      async () => {
        const lines: string[] = [];
        const now = Date.now();

        // 1. Sesión Bukeala (frescura de cookies)
        let s: any = null;
        try { s = await loadSession(env); } catch { /* ignore */ }
        if (s && s.capturedAt) {
          const ageMin = Math.round((now - new Date(s.capturedAt).getTime()) / 60000);
          lines.push(`🔑 Sesión: cookies presentes, capturadas hace ${ageMin} min ${ageMin <= 16 ? "(fresca ✅)" : "(quizá vencida ⚠️)"}`);
        } else {
          lines.push("🔑 Sesión: sin cookies activas (caída) ⚠️");
        }

        // 2. Actividad de la VM (eventos de renovación)
        let events: any[] = [];
        try { const raw = await env.STATE.get("nativeHost:events"); if (raw) events = JSON.parse(raw); } catch { /* ignore */ }
        if (events.length) {
          const last = events[events.length - 1];
          const lastMin = Math.round((now - new Date(last.at).getTime()) / 60000);
          lines.push(`🖥️ VM: último evento hace ${lastMin} min ${lastMin <= 20 ? "(activa ✅)" : "(¿caída? ⚠️)"}`);
          lines.push(`   última: ${last.type} — ${last.message ?? ""}`);
          const recent = events.slice(-12);
          const tgc = recent.filter((e) => /TGC/.test(e.message ?? "")).length;
          const cap = recent.filter((e) => /captcha/.test(e.message ?? "")).length;
          const errs = recent.filter((e) => e.type !== "ok").length;
          lines.push(`📊 Últimas ${recent.length} renovaciones: TGC ${tgc} · captcha ${cap} · errores ${errs}`);
          const lastErr = [...recent].reverse().find((e) => e.type !== "ok");
          if (lastErr) lines.push(`❌ Último error: ${lastErr.at} — ${(lastErr.message ?? "").slice(0, 120)}`);
        } else {
          lines.push("🖥️ VM: sin eventos registrados ⚠️");
        }

        // 3. ¿Refresh pendiente en cola?
        try { if (await env.STATE.get("nativeHost:refreshRequest")) lines.push("🔄 Hay un refresh on-demand pendiente."); } catch { /* ignore */ }

        return textResult("🩺 Estado del sistema\n\n" + lines.join("\n"));
      },
    );

    // ---- WHATSAPP ----

    this.server.tool(
      "enviar_whatsapp",
      "Envía un WhatsApp a un número. Si das 'mensaje' intenta texto libre (solo si hay conversación abierta <24h); si no, o si no das mensaje, envía la plantilla de prueba 'hello_world'.",
      {
        numero: z.string().describe("Número del destinatario (ej 573001234567 o 3001234567)"),
        mensaje: z.string().optional().describe("Texto a enviar (opcional). Si se omite, manda plantilla de prueba."),
      },
      async ({ numero, mensaje }) => {
        const to = normalizeColombianPhone(numero);
        if (!to || to.length < 10) return textResult(`Número inválido: "${numero}".`);
        // Con mensaje: intentar texto libre; si falla (fuera de ventana 24h), caer a plantilla.
        if (mensaje && mensaje.trim()) {
          const r: any = await sendText(env, to, mensaje.trim());
          if (r?.ok) return textResult(`✅ Mensaje enviado a ${to}.`);
          const err = r?.data?.error?.message ?? "fuera de ventana 24h";
          const hw: any = await sendHelloWorld(env, to);
          if (hw?.ok) return textResult(`⚠️ No se pudo enviar texto libre (${err}). Envié la plantilla 'hello_world' a ${to} en su lugar.`);
          return textResult(`❌ No se pudo enviar a ${to}: ${err}`);
        }
        // Sin mensaje: plantilla de prueba (funciona siempre).
        const hw: any = await sendHelloWorld(env, to);
        if (hw?.ok) return textResult(`✅ Plantilla de prueba 'hello_world' enviada a ${to}.`);
        const err = hw?.data?.error?.message ?? `HTTP ${hw?.status ?? "?"}`;
        return textResult(`❌ No se pudo enviar a ${to}: ${err}`);
      },
    );

    // ---- ESCRITURA (Claude pide aprobación al usuario antes de ejecutar) ----

    this.server.tool(
      "abrir_agenda",
      "Abre cupos (agenda) en Bukeala. Crea slots de 20 min. perfil: 'ninos', 'adultos' o 'ambos' (default ambos).",
      {
        dia: z.string().describe("Día de la semana: lunes, martes, ... domingo"),
        inicio: z.string().describe("Hora inicio HH:MM (ej 8:00)"),
        fin: z.string().describe("Hora fin HH:MM (ej 12:20)"),
        perfil: z.enum(["ninos", "adultos", "ambos"]).optional().describe("default: ambos"),
        desde: z.string().optional().describe("Fecha inicio DD/MM/YYYY (opcional)"),
        hasta: z.string().optional().describe("Fecha fin DD/MM/YYYY (opcional)"),
      },
      async ({ dia, inicio, fin, perfil, desde, hasta }) => {
        const parts = [perfil ?? "ambos", dia, `${inicio}-${fin}`];
        if (desde) parts.push(desde);
        if (hasta) parts.push(hasta);
        const r = await handleAbrirAgenda(env, parts.join(" "));
        return textResult(htmlToText(r.reply) + (await maybeWake(r.needsRenew)));
      },
    );

    this.server.tool(
      "cancelar_agenda",
      "Cancela (borra) una agenda por su ID, avisa por WhatsApp a los pacientes de ese día y cancela sus citas. Usa primero listar_agendas para obtener el ID.",
      { id: z.string().describe("ID de la agenda (de listar_agendas)") },
      async ({ id }) => {
        const calId = (id || "").replace(/\D/g, "");
        if (!calId) return textResult("ID inválido. Usa listar_agendas para verlos.");
        const r = await handleCancelarAgenda(env, `confirmar ${calId}`);
        return textResult(htmlToText(r.reply) + (await maybeWake(r.needsRenew)));
      },
    );

    this.server.tool(
      "bloquear_dia",
      "Cierra un día u horario (vacaciones, congreso) para que no se agenden citas. Bloquea ambos perfiles. Avisa si ya hay pacientes ese día (no los cancela).",
      {
        fecha: z.string().describe("Fecha DD/MM/YYYY"),
        inicio: z.string().optional().describe("Hora inicio HH:MM (opcional, default 7:00)"),
        fin: z.string().optional().describe("Hora fin HH:MM (opcional, default 19:00)"),
        motivo: z.string().optional().describe("Motivo (opcional)"),
      },
      async ({ fecha, inicio, fin, motivo }) => {
        const parts = [fecha];
        if (inicio && fin) parts.push(`${inicio}-${fin}`);
        if (motivo) parts.push(motivo);
        const r = await handleBloquearDia(env, parts.join(" "));
        return textResult(htmlToText(r.reply) + (await maybeWake(r.needsRenew)));
      },
    );
  }
}
