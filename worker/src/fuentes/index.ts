/**
 * Registro de fuentes de agenda.
 *
 * Para añadir un cliente con otra agenda: se implementa `FuenteAgenda`, se
 * registra aquí, y el resto del sistema (recordatorios, confirmaciones, lista
 * de la secretaria) funciona sin cambios.
 */
import type { Env } from "../env";
import type { FuenteAgenda } from "./tipos";
import { fuenteBukeala } from "./bukeala";
import { fuenteGCal } from "./gcal";

export const FUENTES: FuenteAgenda[] = [fuenteBukeala, fuenteGCal];

/** Fuentes configuradas en este entorno. */
export function fuentesDisponibles(env: Env): string[] {
  return FUENTES.filter((f) => f.disponible(env)).map((f) => f.nombre);
}

/**
 * Resuelve la fuente a usar. `nombre` viene del cliente (query param o config
 * del tenant); si no viene, se usa la primera disponible — hoy Bukeala, que es
 * el comportamiento actual.
 *
 * Devuelve null si el nombre pedido no existe o no está configurado, para que
 * el llamador responda un error claro en vez de caer a otra fuente en silencio
 * (mandarle a un médico la agenda de otra fuente sería peor que un error).
 */
export function resolverFuente(env: Env, nombre?: string): FuenteAgenda | null {
  if (nombre) {
    const f = FUENTES.find((x) => x.nombre === nombre);
    return f && f.disponible(env) ? f : null;
  }
  return FUENTES.find((f) => f.disponible(env)) ?? null;
}

export * from "./tipos";
