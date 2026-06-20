/**
 * /bloquear_dia — bloquea (cierra) un día u horario para que NO se agenden
 * citas: vacaciones, congreso, etc. Usa el "deny date" de Bukeala.
 *
 * Maneja los DOS perfiles (niños 1222 + adultos 1218) a la vez.
 * Avisa cuántos pacientes ya tenían cita ese día (para que el Dr. decida).
 *
 * Sintaxis:
 *   /bloquear_dia <DD/MM/YYYY> [HH:MM-HH:MM] [motivo...]
 *
 * Ejemplos:
 *   /bloquear_dia 24/06/2026                  → bloquea todo el día (7am-7pm)
 *   /bloquear_dia 24/06/2026 8:00-12:00 congreso
 *
 * Del HAR agendas2: POST /saveDenyDate {areas, reasonId, bookingComponents,
 * startHour, endHour, selectedDates}. reasonId "2" por defecto.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";

const AREA_ID = 1074;
const BOOKING_COMPONENTS = [1222, 1218]; // niños + adultos
const DEFAULT_START = 7 * 3600;  // 7:00am
const DEFAULT_END = 19 * 3600;   // 7:00pm

function hhmmToSeconds(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h * 3600 + mm * 60;
}

export async function handleBloquearDia(
  env: Env,
  argsText: string,
): Promise<{ reply: string; needsRenew?: boolean }> {
  const parts = argsText.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || !/^\d{2}\/\d{2}\/\d{4}$/.test(parts[0])) {
    return { reply: helpText() };
  }

  const fecha = parts[0];                       // DD/MM/YYYY
  const fechaDash = fecha.replace(/\//g, "-");  // DD-MM-YYYY (formato denyDate y getAgenda)

  // Horario opcional
  let startSec = DEFAULT_START;
  let endSec = DEFAULT_END;
  let motivoStart = 1;
  if (parts[1] && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(parts[1])) {
    const [a, z] = parts[1].split("-");
    const s = hhmmToSeconds(a), e = hhmmToSeconds(z);
    if (s === null || e === null || e <= s) {
      return { reply: `❌ Horario inválido: "${parts[1]}". Usa 8:00-12:00.` };
    }
    startSec = s; endSec = e; motivoStart = 2;
  }
  const comment = parts.slice(motivoStart).join(" ").slice(0, 200);

  const b = new Bukeala(env);

  // 1. Contar pacientes ya agendados ese día/horario (para avisar al Dr.)
  let pacientes = 0;
  try {
    for (const comp of BOOKING_COMPONENTS) {
      const res = await b.countBookingsForDenyDate({
        bookingComponentId: comp,
        areaId: AREA_ID,
        timeFromSeconds: startSec,
        timeToSeconds: endSec,
        dateDdMmYyyy: fechaDash,
        isPartial: true,
      });
      const t = (await res.text()).trim();
      const n = parseInt(t, 10);
      if (Number.isFinite(n)) pacientes += n;
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) return { reply: "⚠️ Sesión caída. La estoy despertando…", needsRenew: true };
    console.log("[bloquearDia] count falló:", (e as Error).message);
  }

  // 2. Crear el bloqueo (deny date) para ambos perfiles
  try {
    const res = await b.saveDenyDate({
      areaId: AREA_ID,
      bookingComponentIds: BOOKING_COMPONENTS,
      reasonId: "2",
      comment,
      startHourSeconds: startSec,
      endHourSeconds: endSec,
      selectedDates: [fechaDash],
    });
    const j = await res.json<any>().catch(() => null);
    if (j?.result?.code !== "SUCCESS") {
      const msg = j?.messages?.[0]?.description ?? j?.result?.description ?? "error";
      return { reply: `❌ No se pudo bloquear: ${escapeHtml(String(msg).slice(0, 150))}` };
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) return { reply: "⚠️ Sesión caída. La estoy despertando…", needsRenew: true };
    return { reply: `❌ Error: ${escapeHtml((e as Error).message.slice(0, 120))}` };
  }

  const hStr = (startSec === DEFAULT_START && endSec === DEFAULT_END)
    ? "todo el día"
    : `${secs2hhmm(startSec)}-${secs2hhmm(endSec)}`;
  const lines = [
    `🚫 <b>Día bloqueado</b>`,
    `📅 ${escapeHtml(fecha)} · ${hStr}`,
    `👥 Ambos perfiles (niños + adultos)`,
    comment ? `📝 ${escapeHtml(comment)}` : "",
    ``,
    `Ya no se podrán agendar citas nuevas en ese horario.`,
  ];
  if (pacientes > 0) {
    lines.push(
      ``,
      `⚠️ <b>OJO:</b> ya hay <b>${pacientes}</b> paciente(s) con cita ese día.`,
      `El bloqueo NO los cancela. Si quieres cancelarlos, usa /cancelar_agenda o avísales.`,
    );
  }
  return { reply: lines.filter(Boolean).join("\n") };
}

function secs2hhmm(s: number): string {
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

function helpText(): string {
  return [
    "🚫 <b>Bloquear día (cerrar agenda)</b>",
    "",
    "<code>/bloquear_dia &lt;DD/MM/YYYY&gt; [HH:MM-HH:MM] [motivo]</code>",
    "",
    "Ejemplos:",
    "<code>/bloquear_dia 24/06/2026</code> (todo el día)",
    "<code>/bloquear_dia 24/06/2026 8:00-12:00 congreso</code>",
    "",
    "• Bloquea ambos perfiles (niños + adultos)",
    "• Sin horario = 7am-7pm",
    "• Avisa si ya hay pacientes con cita ese día (no los cancela)",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
