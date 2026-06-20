/**
 * /cancelar_agenda — borra agendas (calendarios) en Bukeala, con confirmación
 * previa y aviso a los pacientes afectados.
 *
 * Flujo seguro (2 pasos):
 *   1. /cancelar_agenda                  → lista las agendas existentes (con id)
 *      o /cancelar_agenda <DD/MM/YYYY>   → filtra las de esa fecha
 *   2. /cancelar_agenda confirmar <id>   → cuenta pacientes, los avisa por
 *      WhatsApp, borra el calendario, e informa al doctor.
 *
 * Maneja los DOS perfiles (niños 1222 + adultos 1218): lista de ambos.
 *
 * Solo doctores. La cancelación de las CITAS individuales se hace con el
 * reservationCode que trae la agenda diaria (getAgenda); si no viene, se
 * reporta para cancelarlas con /cancelar.
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { sendText } from "../whatsapp";

const PROFILES = [
  { id: "1222", label: "Niños/adolescentes" },
  { id: "1218", label: "Adultos" },
];
const AREA_ID = 1074;

interface CalInfo {
  id: number;
  desc: string;
  startFmt: string;
  endFmt: string;
  startSec: number;
  endSec: number;
  state: string;
  profile: string;
}

function secs2hhmm(s: number): string {
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** Lista calendarios de ambos perfiles. */
async function listCalendars(b: Bukeala): Promise<CalInfo[]> {
  const out: CalInfo[] = [];
  for (const prof of PROFILES) {
    try {
      const res = await b.selectBookingComponent(prof.id);
      const j = await res.json<any>().catch(() => null);
      const cals = j?.bookingComponent?.bookingCalendars ?? [];
      for (const c of cals) {
        out.push({
          id: c.id,
          desc: c.description ?? "",
          startFmt: c.startDateFormatted ?? "",
          endFmt: c.endDateFormatted ?? "",
          startSec: c.minStartBookingSeconds ?? 0,
          endSec: c.maxStartBookingSeconds ?? 0,
          state: c.stateDescription ?? c.stateCode ?? "",
          profile: prof.label,
        });
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      console.log(`[cancelarAgenda] list ${prof.id} falló:`, (e as Error).message);
    }
  }
  return out;
}

export async function handleCancelarAgenda(
  env: Env,
  argsText: string,
): Promise<{ reply: string; needsRenew?: boolean }> {
  const b = new Bukeala(env);
  const parts = argsText.trim().split(/\s+/).filter(Boolean);

  // --- Paso 2: confirmar <id> ---
  if (parts[0]?.toLowerCase() === "confirmar" && parts[1]) {
    const calId = parts[1].replace(/\D/g, "");
    if (!calId) return { reply: "❌ ID de agenda inválido." };
    return await confirmarCancelacion(env, b, calId);
  }

  // --- Paso 1: listar ---
  let cals: CalInfo[];
  try {
    cals = await listCalendars(b);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return { reply: "⚠️ Sesión Bukeala caída. La estoy despertando…", needsRenew: true };
    }
    return { reply: `❌ Error listando agendas: ${escapeHtml((e as Error).message.slice(0, 120))}` };
  }

  // Filtro opcional por fecha (DD/MM/YYYY → compara con startFmt DD/MM/YY)
  const dateFilter = parts[0] && /^\d{2}\/\d{2}\/\d{4}$/.test(parts[0]) ? parts[0] : null;
  let shown = cals;
  if (dateFilter) {
    const short = dateFilter.slice(0, 6) + dateFilter.slice(8); // DD/MM/YYYY → DD/MM/YY
    shown = cals.filter((c) => c.startFmt === short || c.desc.includes(short));
  }

  if (shown.length === 0) {
    return { reply: dateFilter
      ? `📭 No hay agendas para ${dateFilter}.`
      : "📭 No hay agendas abiertas en este momento." };
  }

  const lines = [`📋 <b>Agendas abiertas</b>${dateFilter ? ` · ${dateFilter}` : ""}`, ""];
  for (const c of shown.slice(0, 30)) {
    lines.push(
      `🆔 <code>${c.id}</code> · ${escapeHtml(c.profile)}`,
      `   ${escapeHtml(c.startFmt)}→${escapeHtml(c.endFmt)} · ${secs2hhmm(c.startSec)}-${secs2hhmm(c.endSec)} · ${escapeHtml(c.state)}`,
    );
  }
  lines.push("", "<i>Para cancelar una: <code>/cancelar_agenda confirmar &lt;ID&gt;</code></i>");
  lines.push("<i>(Eso avisará a los pacientes de ese día y borrará la agenda.)</i>");
  return { reply: lines.join("\n") };
}

async function confirmarCancelacion(
  env: Env,
  b: Bukeala,
  calId: string,
): Promise<{ reply: string; needsRenew?: boolean }> {
  // 1. Ubicar el calendario (para saber fecha/horas/perfil y avisar pacientes)
  let cal: CalInfo | undefined;
  try {
    const all = await listCalendars(b);
    cal = all.find((c) => String(c.id) === calId);
  } catch (e) {
    if (e instanceof SessionExpiredError) return { reply: "⚠️ Sesión caída. La estoy despertando…", needsRenew: true };
  }
  if (!cal) {
    return { reply: `❌ No encontré la agenda <code>${escapeHtml(calId)}</code>. Lista con /cancelar_agenda.` };
  }

  // 2. Buscar pacientes agendados en ese día (agenda diaria del área)
  //    El calendario puede cubrir un rango; avisamos a los del día de inicio.
  //    getAgenda usa DD-MM-YYYY (con guiones).
  const ddmmyyyy = cal.startFmt; // DD/MM/YY
  let avisados = 0;
  let pacientesInfo: string[] = [];
  let citasNoCanceladas = 0;
  try {
    // Convertir DD/MM/YY → DD-MM-YYYY (asumiendo 20YY)
    const m = ddmmyyyy.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (m) {
      const dashed = `${m[1]}-${m[2]}-20${m[3]}`;
      const res = await b.getAgenda(dashed, AREA_ID, false);
      const j = await res.json<any>().catch(() => null);
      const bookings: any[] = j?.areas?.[0]?.bookings ?? [];
      const active = bookings.filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime);

      for (const bk of active) {
        const name = bk.name ?? "Paciente";
        const phone = extractPhone(bk);
        const time = bk.startHourFormatted ?? "";
        // Avisar al paciente por WhatsApp (si tiene teléfono y dentro de ventana 24h)
        if (phone) {
          try {
            await sendText(
              env,
              phone,
              `Hola ${name.split(" ")[0]}, lamentamos informarle que su cita del ${ddmmyyyy} a las ${time} con el Dr. David Duque debe ser reprogramada. Por favor escríbanos para reagendar. Disculpe el inconveniente.`,
            );
            avisados++;
          } catch { /* fuera de ventana 24h o sin tel */ }
        }
        // Intentar cancelar la cita si trae reservationCode
        const rc = bk.reservationCode ?? bk.reservationCodeStr ?? null;
        if (rc) {
          try {
            await b.cancelBooking({ reservationCode: String(rc), cancelReasonId: "2", cancelationComment: "Agenda cancelada por el Dr." });
          } catch { citasNoCanceladas++; }
        } else {
          citasNoCanceladas++;
        }
        pacientesInfo.push(`• ${name} ${time}${phone ? " 📞" : ""}`);
      }
    }
  } catch (e) {
    console.log("[cancelarAgenda] aviso pacientes falló:", (e as Error).message);
  }

  // 3. Borrar el calendario (molde)
  try {
    const res = await b.deleteBookingCalendar([calId]);
    const j = await res.json<any>().catch(() => null);
    if (j?.result?.code !== "SUCCESS") {
      const msg = j?.messages?.[0]?.description ?? j?.result?.description ?? "error";
      return { reply: `❌ No se pudo borrar la agenda: ${escapeHtml(String(msg).slice(0, 150))}` };
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) return { reply: "⚠️ Sesión caída. La estoy despertando…", needsRenew: true };
    return { reply: `❌ Error borrando agenda: ${escapeHtml((e as Error).message.slice(0, 120))}` };
  }

  // 4. Resumen al doctor
  const lines = [
    `✅ <b>Agenda cancelada</b>`,
    `🆔 <code>${escapeHtml(calId)}</code> · ${escapeHtml(cal.profile)} · ${escapeHtml(cal.startFmt)}`,
    ``,
    `👥 Pacientes ese día: ${pacientesInfo.length}`,
    `📲 Avisados por WhatsApp: ${avisados}`,
  ];
  if (citasNoCanceladas > 0) {
    lines.push(`⚠️ Citas que debes cancelar manual (sin código): ${citasNoCanceladas}`);
  }
  if (pacientesInfo.length > 0) {
    lines.push(``, ...pacientesInfo.slice(0, 20));
  }
  return { reply: lines.join("\n") };
}

function extractPhone(bk: any): string {
  if (typeof bk.cellPhone === "string" && bk.cellPhone.trim()) return bk.cellPhone.trim();
  if (bk.cellPhone && typeof bk.cellPhone === "object" && bk.cellPhone.phoneNumber) {
    return String(bk.cellPhone.phoneNumber).trim();
  }
  if (typeof bk.phone === "string" && bk.phone.trim()) return bk.phone.trim();
  if (typeof bk.customerPhone === "string" && bk.customerPhone.trim()) return bk.customerPhone.trim();
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
