/**
 * /abrir_agenda — abre cupos (disponibilidad) en Bukeala desde Telegram.
 *
 * Replica el flujo del HAR "crear agenda": valida sala libre + createSchedule.
 * Solo doctores. Slots de 20 min, área del Dr. (1074), componente CIRUGÍA
 * PLÁSTICA (1222), sin sala específica (roomId 0). Esos valores son fijos
 * (de tu config real); el comando solo varía día, horas y rango de fechas.
 *
 * Sintaxis:
 *   /abrir_agenda <día> <HH:MM>-<HH:MM> [DD/MM/YYYY DD/MM/YYYY]
 *
 * Ejemplos:
 *   /abrir_agenda jueves 8:00-12:20
 *   /abrir_agenda lunes 7:00-13:00 01/07/2026 31/07/2026
 *   /abrir_agenda mié 9:00-12:00            (acepta abreviaturas y sin tildes)
 */
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";

// Config fija (del HAR real del Dr. Duque)
const COMPONENT_ID = "1222";
const COMPONENT_CODE = "890239-1";
const AREA_ID = "1074";
const SLOT_SECONDS = 1200; // 20 min
const DEFAULT_WEEKS = 2;   // si no dan rango, abre 2 semanas

// Mapa día → número Bukeala. En el HAR, jueves = "4".
// Deducción: lunes=1, martes=2, miércoles=3, jueves=4, viernes=5, sábado=6, domingo=7.
const DAY_MAP: Record<string, { num: string; label: string }> = {
  "lunes": { num: "1", label: "Lunes" }, "lun": { num: "1", label: "Lunes" },
  "martes": { num: "2", label: "Martes" }, "mar": { num: "2", label: "Martes" },
  "miercoles": { num: "3", label: "Miércoles" }, "mie": { num: "3", label: "Miércoles" }, "mié": { num: "3", label: "Miércoles" },
  "jueves": { num: "4", label: "Jueves" }, "jue": { num: "4", label: "Jueves" },
  "viernes": { num: "5", label: "Viernes" }, "vie": { num: "5", label: "Viernes" },
  "sabado": { num: "6", label: "Sábado" }, "sab": { num: "6", label: "Sábado" }, "sáb": { num: "6", label: "Sábado" },
  "domingo": { num: "7", label: "Domingo" }, "dom": { num: "7", label: "Domingo" },
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function hhmmToSeconds(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h * 3600 + mm * 60;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function todayBogotaDdMmYyyy(offsetDays = 0): string {
  const now = new Date();
  const bog = new Date(now.getTime() - 5 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return `${pad2(bog.getUTCDate())}/${pad2(bog.getUTCMonth() + 1)}/${bog.getUTCFullYear()}`;
}

function validDate(s: string): boolean {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s);
}

export interface AbrirAgendaResult { reply: string; }

/**
 * Parsea y ejecuta /abrir_agenda. Devuelve el mensaje a enviar al doctor.
 * @param argsText  lo que viene después de "/abrir_agenda"
 */
export async function handleAbrirAgenda(env: Env, argsText: string): Promise<AbrirAgendaResult> {
  const parts = argsText.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { reply: helpText() };
  }

  // 1. Día
  const dayKey = stripAccents(parts[0].toLowerCase());
  const day = DAY_MAP[dayKey];
  if (!day) {
    return { reply: `❌ Día no reconocido: "${parts[0]}".\n\n${helpText()}` };
  }

  // 2. Rango horario HH:MM-HH:MM
  const rangeM = parts[1].match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!rangeM) {
    return { reply: `❌ Horario inválido: "${parts[1]}". Usa formato 8:00-12:20.\n\n${helpText()}` };
  }
  const startSeconds = hhmmToSeconds(rangeM[1]);
  const endSeconds = hhmmToSeconds(rangeM[2]);
  if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
    return { reply: `❌ Horas inválidas o fin ≤ inicio: "${parts[1]}".` };
  }

  // 3. Fechas opcionales
  let startDate = todayBogotaDdMmYyyy(0);
  let endDate = todayBogotaDdMmYyyy(DEFAULT_WEEKS * 7);
  if (parts.length >= 4) {
    if (!validDate(parts[2]) || !validDate(parts[3])) {
      return { reply: `❌ Fechas inválidas. Usa DD/MM/YYYY DD/MM/YYYY.\n\n${helpText()}` };
    }
    startDate = parts[2];
    endDate = parts[3];
  } else if (parts.length === 3 && validDate(parts[2])) {
    // Solo fecha de inicio → 2 semanas desde ahí
    startDate = parts[2];
    const [d, mo, y] = parts[2].split("/").map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, mo - 1, d) + DEFAULT_WEEKS * 7 * 86400 * 1000);
    endDate = `${pad2(dt.getUTCDate())}/${pad2(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`;
  }

  const b = new Bukeala(env);

  // 4. Validar sala libre (no bloqueante si falla la validación misma)
  try {
    const vr = await b.validateRoomAvailability({
      roomId: 0,
      areaId: parseInt(AREA_ID, 10),
      startDateStr: startDate,
      endDateStr: endDate,
      startSeconds,
      endSeconds,
      daysSelectedStr: `${day.num}-`,
      repeatWeek: 1,
    });
    const vt = await vr.text();
    let vj: any = null;
    try { vj = JSON.parse(vt); } catch { /* ignore */ }
    if (vj?.result?.code && vj.result.code !== "SUCCESS") {
      const msg = vj.messages?.[0]?.description || vj.result.description || vj.result.code;
      return { reply: `⚠️ No se puede abrir ese horario: ${escapeHtml(String(msg))}\n\n<i>Puede que ya haya un bloque que se cruza.</i>` };
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return { reply: "⚠️ Sesión Bukeala caída. Corre /sesion_renew y reintenta." };
    }
    // si la validación falla por otra cosa, seguimos e intentamos crear igual
    console.log("[abrirAgenda] validate falló (continuo):", (e as Error).message);
  }

  // 5. Crear el horario
  try {
    const res = await b.createSchedule({
      bookingComponentId: COMPONENT_ID,
      componentCode: COMPONENT_CODE,
      daysSelected: [day.num],
      areaId: AREA_ID,
      startBookingSeconds: startSeconds,
      endBookingSeconds: endSeconds,
      startDate,
      endDate,
      intervalSeconds: SLOT_SECONDS,
      repeatWeek: 1,
      roomId: 0,
      allowHolidays: "REGULAR",
    });
    const txt = await res.text();
    let j: any = null;
    try { j = JSON.parse(txt); } catch { /* ignore */ }

    if (j?.result?.code === "SUCCESS") {
      const slots = Math.floor((endSeconds - startSeconds) / SLOT_SECONDS);
      return {
        reply: [
          `✅ <b>Agenda abierta</b>`,
          ``,
          `📅 ${day.label}s`,
          `⏰ ${rangeM[1]} – ${rangeM[2]} (slots de 20 min ≈ ${slots} cupos)`,
          `🗓️ Vigencia: ${startDate} → ${endDate}`,
          ``,
          `<i>Los pacientes ya pueden agendar en esos cupos.</i>`,
        ].join("\n"),
      };
    }

    const errMsg = j?.messages?.[0]?.description ?? j?.result?.description ?? `HTTP ${res.status}`;
    return { reply: `❌ No se pudo crear: ${escapeHtml(String(errMsg).replace(/<[^>]+>/g, "").slice(0, 200))}` };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return { reply: "⚠️ Sesión Bukeala caída justo al crear. Corre /sesion_renew y reintenta." };
    }
    return { reply: `❌ Error: ${escapeHtml((e as Error).message.slice(0, 150))}` };
  }
}

function helpText(): string {
  return [
    "📋 <b>Abrir agenda (cupos)</b>",
    "",
    "<code>/abrir_agenda &lt;día&gt; &lt;inicio&gt;-&lt;fin&gt; [desde] [hasta]</code>",
    "",
    "Ejemplos:",
    "<code>/abrir_agenda jueves 8:00-12:20</code>",
    "<code>/abrir_agenda lunes 7:00-13:00 01/07/2026 31/07/2026</code>",
    "",
    "• Slots de 20 min · agenda del Dr. Duque",
    "• Sin fechas = próximas 2 semanas",
    "• Días: lunes, martes, miércoles, jueves, viernes, sábado, domingo (o lun/mar/mié...)",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
