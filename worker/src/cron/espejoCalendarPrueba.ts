/**
 * Autoprueba del espejo Bukeala → Google Calendar.
 *
 * POR QUÉ EXISTE
 * Bukeala se cae por días enteros (Radware), y justo entonces es cuando uno
 * quiere saber si el espejo sigue sano. Esta prueba ejercita EXACTAMENTE el
 * mismo código de sincronización (`sincronizarConCalendar`) con citas
 * sintéticas, pero:
 *   - sin leer Bukeala (le pasamos la "lectura" armada a mano), y
 *   - sobre un calendario TEMPORAL que crea el propio service account y que
 *     se borra al final (también si algo falla). El calendario del Dr. no se
 *     toca; no hay forma de pasarle su id.
 *
 * Verifica, en orden: crear → idempotencia (segunda corrida sin cambios) →
 * actualizar cuando Bukeala cambia → cancelar por evidencia positiva →
 * restaurar → cancelar por ausencia en día leído → NO cancelar por ausencia
 * en día no leído → abortar con cero citas → tope de cancelaciones (nada se
 * escribe) → forzar.
 *
 *   GET /debug/espejo-calendar?token=<CAPTURE_TOKEN>&autoprueba=1
 */
import type { Env } from "../env";
import { createCalendar, deleteCalendar, listEventsFiltrado } from "../gcal";
import {
  TOPE_CANCELACIONES,
  armarVentana,
  dashedAIso,
  isoLocal,
  resumenVacio,
  sincronizarConCalendar,
  type CitaNormalizada,
  type LecturaBukeala,
  type ResumenEspejo,
  type Ventana,
} from "./espejoCalendar";

export interface PasoPrueba {
  paso: string;
  esperado: Record<string, number | boolean>;
  obtenido: Record<string, number | boolean | string | undefined>;
  ok: boolean;
}

export interface ReporteAutoprueba {
  ok: boolean;
  calendarioTemporal: string;
  calendarioBorrado: boolean;
  pasos: PasoPrueba[];
  duracionMs: number;
}

const NOMBRE_TEMP = "PRUEBA ESPEJO (temporal, se borra sola)";

function cita(v: Ventana, id: string, diaOffset: number, horaMin: number, nombre: string, extra: Partial<CitaNormalizada> = {}): CitaNormalizada {
  const fecha = v.fechas[diaOffset];
  const iso = dashedAIso(fecha);
  return {
    id,
    fecha,
    inicio: isoLocal(iso, horaMin),
    fin: isoLocal(iso, horaMin + 20),
    paciente: nombre,
    documento: `CC 900${id.replace(/\D/g, "").padStart(6, "0")}`,
    cedula: "",
    plan: "PRUEBA",
    codigo: `PR-${id}`,
    tipo: "Consulta de prueba",
    estadoCodigo: "PENDING",
    estadoTexto: "Pendiente",
    presencial: true,
    notas: "",
    cancelada: false,
    ...extra,
  };
}

function lectura(v: Ventana, activas: CitaNormalizada[], canceladas: CitaNormalizada[] = [], diasOk?: string[]): LecturaBukeala {
  return {
    activas: new Map(activas.map((c) => [c.id, c])),
    canceladas: new Map(canceladas.map((c) => [c.id, { ...c, cancelada: true }])),
    diasOk: new Set(diasOk ?? v.fechas),
    diasFallidos: (diasOk ? v.fechas.filter((f) => !diasOk.includes(f)) : []).map((fecha) => ({ fecha, motivo: "simulado" })),
  };
}

export async function autoPruebaEspejo(env: Env): Promise<ReporteAutoprueba> {
  const t0 = Date.now();
  const pasos: PasoPrueba[] = [];
  const v = armarVentana(3);

  // Calendario temporal propio del service account: aislamiento total.
  const cal = await createCalendar(env, NOMBRE_TEMP);
  const calId = cal.id;
  let borrado = false;

  const correr = async (l: LecturaBukeala, opts: { forzarCancelaciones?: boolean } = {}): Promise<ResumenEspejo> => {
    const r = resumenVacio(v);
    await sincronizarConCalendar(env, calId, l, v, { ...opts, origen: "manual" }, r);
    return r;
  };
  const check = (paso: string, r: ResumenEspejo, esperado: Record<string, number | boolean>) => {
    const obtenido: PasoPrueba["obtenido"] = {};
    let ok = true;
    for (const [k, val] of Object.entries(esperado)) {
      const real = (r as any)[k];
      obtenido[k] = real;
      if (real !== val) ok = false;
    }
    if (r.errores.length) {
      obtenido.errores = r.errores.slice(0, 2).join(" | ");
      ok = false;
    }
    if (r.motivo) obtenido.motivo = r.motivo;
    pasos.push({ paso, esperado, obtenido, ok });
  };
  /** Cuántos eventos espejados hay VIVOS en el calendario temporal. */
  const vivos = async (): Promise<number> => {
    const evs = await listEventsFiltrado(env, calId, { privateProps: { origen: "bukeala" }, showDeleted: true });
    return evs.filter((e) => e.status !== "cancelled").length;
  };

  try {
    const A = cita(v, "t1", 1, 8 * 60, "PRUEBA ESPEJO A");
    const B = cita(v, "t2", 1, 9 * 60, "PRUEBA ESPEJO B");

    check("1 crear A y B", await correr(lectura(v, [A, B])), { creados: 2, actualizados: 0, cancelados: 0, abortado: false });
    check("2 idempotencia: misma lectura, nada cambia", await correr(lectura(v, [A, B])), { creados: 0, actualizados: 0, sinCambios: 2, cancelados: 0 });
    const A2 = { ...A, inicio: isoLocal(dashedAIso(A.fecha), 10 * 60), fin: isoLocal(dashedAIso(A.fecha), 10 * 60 + 20) };
    check("3 A cambió de hora en Bukeala → actualizar solo A", await correr(lectura(v, [A2, B])), { creados: 0, actualizados: 1, sinCambios: 1, cancelados: 0 });
    check("4 B CANCELED en Bukeala (evidencia positiva) → cancelar B", await correr(lectura(v, [A2], [B])), { cancelados: 1, sinCambios: 1, creados: 0 });
    check("5 B vuelve a estar activa → restaurar (no duplicar)", await correr(lectura(v, [A2, B])), { restaurados: 1, creados: 0, sinCambios: 1 });
    check("6 B desaparece de un día LEÍDO → cancelar por ausencia", await correr(lectura(v, [A2])), { cancelados: 1, sinCambios: 1, creados: 0 });
    check("7 B activa otra vez → restaurar", await correr(lectura(v, [A2, B])), { restaurados: 1, creados: 0 });
    // El día de A y B (fechas[1]) NO se leyó: su ausencia no puede cancelar nada.
    const C = cita(v, "t3", 2, 8 * 60, "PRUEBA ESPEJO C");
    check("8 día de A/B NO leído y ausentes → NO cancelar (crear C)", await correr(lectura(v, [C], [], [v.fechas[0], v.fechas[2]])), { cancelados: 0, creados: 1, abortado: false });
    check("9 cero citas activas → abortar sin tocar", await correr(lectura(v, [])), { abortado: true, cancelados: 0, creados: 0 });
    check("10 ningún día leído → abortar sin tocar", await correr(lectura(v, [A2, B, C], [], [])), { abortado: true, cancelados: 0, creados: 0 });

    // Tope: TOPE+1 citas vivas y luego todas ausentes en días leídos.
    const muchas = Array.from({ length: TOPE_CANCELACIONES + 1 }, (_, i) => cita(v, `m${i}`, 2, 12 * 60 + i * 20, `PRUEBA ESPEJO M${i}`));
    check("11 crear las del tope", await correr(lectura(v, [A2, B, C, ...muchas])), { creados: TOPE_CANCELACIONES + 1, abortado: false });
    const antes = await vivos();
    const r12 = await correr(lectura(v, [A2, B, C]));
    check(`12 ${muchas.length} ausentes > tope ${TOPE_CANCELACIONES} → abortar, NADA escrito`, r12, { abortado: true, cancelados: 0, cancelacionesRetenidas: muchas.length });
    pasos.push({
      paso: "12b eventos vivos intactos tras el abort",
      esperado: { vivos: antes },
      obtenido: { vivos: await vivos() },
      ok: (await vivos()) === antes,
    });
    check("13 forzar → sí cancela", await correr(lectura(v, [A2, B, C]), { forzarCancelaciones: true }), { abortado: false, cancelados: muchas.length, sinCambios: 3 });
  } finally {
    try {
      await deleteCalendar(env, calId);
      borrado = true;
    } catch (e) {
      console.log("[espejo:prueba] no se pudo borrar el calendario temporal:", (e as Error).message);
    }
  }

  return {
    ok: pasos.every((p) => p.ok) && borrado,
    calendarioTemporal: calId,
    calendarioBorrado: borrado,
    pasos,
    duracionMs: Date.now() - t0,
  };
}
