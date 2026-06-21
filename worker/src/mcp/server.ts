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
import { requestRefresh } from "../handlers/nativeHostEvent";
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
