/**
 * Abstracción de canal de mensajería (WhatsApp / Instagram / futuro).
 *
 * El booking agent (claudeBookingAgent.ts) usa este interface para enviar
 * mensajes al paciente y guardar contexto en KV con prefijos por canal —
 * de modo que un paciente que escribe por WhatsApp tiene su contexto
 * separado de uno que escribe por Instagram (al menos hasta que los unifiquemos
 * por cédula).
 */
import type { Env } from "./env";
import { sendText as waSendText } from "./whatsapp";
import { sendIgText } from "./instagram";

export interface MessagingChannel {
  /** Identificador corto del canal — usado como prefijo de KV keys */
  kvPrefix: "wa" | "ig";

  /** Nombre humano del canal para logs y notificaciones */
  label: "WhatsApp" | "Instagram";

  /** Envía texto plano al destinatario */
  sendText(env: Env, to: string, text: string): Promise<{ ok: boolean; status?: number; data?: any }>;

  /**
   * Si el canal soporta plantillas pre-aprobadas para mensajes proactivos
   * fuera de ventana. WhatsApp sí (24h window), Instagram no (7d window
   * pero sin templates — solo texto libre dentro de ventana).
   */
  supportsTemplates: boolean;
}

export const WHATSAPP_CHANNEL: MessagingChannel = {
  kvPrefix: "wa",
  label: "WhatsApp",
  sendText: (env, to, text) => waSendText(env, to, text),
  supportsTemplates: true,
};

export const INSTAGRAM_CHANNEL: MessagingChannel = {
  kvPrefix: "ig",
  label: "Instagram",
  sendText: (env, to, text) => sendIgText(env, to, text),
  supportsTemplates: false,
};
