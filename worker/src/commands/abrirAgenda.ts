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
const AREA_ID = "1074";
const SLOT_SECONDS = 1200; // 20 min
const DEFAULT_WEEKS = 2;   // si no dan rango, abre 2 semanas

// Los DOS perfiles de agenda (verificado en HAR agendas2):
//   niños/adolescentes → componente 1222, código 890239-1
//   adultos            → componente 1218, código 890239
const PROFILES = {
  ninos:   { id: "1222", code: "890239-1", label: "Niños y adolescentes" },
  adultos: { id: "1218", code: "890239",   label: "Adultos" },
} as const;
type ProfileKey = keyof typeof PROFILES;

// Palabras que el doctor puede usar para elegir perfil
const PROFILE_ALIASES: Record<string, ProfileKey> = {
  "ninos": "ninos", "niños": "ninos", "nino": "ninos", "niño": "ninos",
  "adolescentes": "ninos", "ado": "ninos", "pediatrico": "ninos", "pediátrico": "ninos",
  "adultos": "adultos", "adulto": "adultos", "adt": "adultos",
  "ambos": "AMBOS" as any, "dual": "AMBOS" as any, "todos": "AMBOS" as any, "simultaneo": "AMBOS" as any, "simultáneo": "AMBOS" as any,
};

// Mapa día → número Bukeala. VERIFICADO con prueba real:
// Bukeala usa Domingo=1, Lunes=2, Martes=3, Miércoles=4, Jueves=5, Viernes=6, Sábado=7.
// (En el HAR daysSelected="4" con fecha de inicio viernes 19/06/26 era para Miércoles;
//  y al pedir "6" Bukeala respondió "Viernes" → confirma este mapeo.)
const DAY_MAP: Record<string, { num: string; label: string }> = {
  "domingo": { num: "1", label: "Domingo" }, "dom": { num: "1", label: "Domingo" },
  "lunes": { num: "2", label: "Lunes" }, "lun": { num: "2", label: "Lunes" },
  "martes": { num: "3", label: "Martes" }, "mar": { num: "3", label: "Martes" },
  "miercoles": { num: "4", label: "Miércoles" }, "mie": { num: "4", label: "Miércoles" }, "mié": { num: "4", label: "Miércoles" },
  "jueves": { num: "5", label: "Jueves" }, "jue": { num: "5", label: "Jueves" },
  "viernes": { num: "6", label: "Viernes" }, "vie": { num: "6", label: "Viernes" },
  "sabado": { num: "7", label: "Sábado" }, "sab": { num: "7", label: "Sábado" }, "sáb": { num: "7", label: "Sábado" },
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

export interface AbrirAgendaResult { reply: string; needsRenew?: boolean; }

/**
 * Parsea y ejecuta /abrir_agenda. Devuelve el mensaje a enviar al doctor.
 * @param argsText  lo que viene después de "/abrir_agenda"
 */
export async function handleAbrirAgenda(env: Env, argsText: string): Promise<AbrirAgendaResult> {
  let parts = argsText.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return { reply: helpText() };
  }

  // 0. Perfil opcional como primer token: ninos | adultos | ambos.
  //    Si no se especifica, default = AMBOS (niños + adultos simultáneo).
  let profiles: ProfileKey[] = ["ninos", "adultos"];
  let profileLabel = "Ambos perfiles (niños + adultos)";
  const firstKey = stripAccents(parts[0].toLowerCase());
  if (PROFILE_ALIASES[firstKey]) {
    const sel = PROFILE_ALIASES[firstKey];
    if ((sel as string) === "AMBOS") {
      profiles = ["ninos", "adultos"];
      profileLabel = "Ambos perfiles (niños + adultos)";
    } else {
      profiles = [sel];
      profileLabel = PROFILES[sel].label;
    }
    parts = parts.slice(1); // consumir el token de perfil
  }
  if (parts.length < 2) {
    return { reply: `❌ Falta día y horario.\n\n${helpText()}` };
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
    startDate = parts[2];
    const [d, mo, y] = parts[2].split("/").map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, mo - 1, d) + DEFAULT_WEEKS * 7 * 86400 * 1000);
    endDate = `${pad2(dt.getUTCDate())}/${pad2(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`;
  }

  const b = new Bukeala(env);
  const slots = Math.floor((endSeconds - startSeconds) / SLOT_SECONDS);

  // 4. Crear el horario para cada perfil seleccionado
  const ok: string[] = [];
  const failed: string[] = [];
  try {
    for (const pk of profiles) {
      const prof = PROFILES[pk];
      const res = await b.createSchedule({
        bookingComponentId: prof.id,
        componentCode: prof.code,
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
        ok.push(prof.label);
      } else {
        const errMsg = j?.messages?.[0]?.description ?? j?.result?.description ?? `HTTP ${res.status}`;
        failed.push(`${prof.label}: ${String(errMsg).replace(/<[^>]+>/g, "").slice(0, 120)}`);
      }
    }
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return { reply: "⚠️ Sesión Bukeala caída. La estoy despertando…", needsRenew: true };
    }
    return { reply: `❌ Error: ${escapeHtml((e as Error).message.slice(0, 150))}` };
  }

  // 5. Resumen
  const lines: string[] = [];
  if (ok.length > 0) {
    lines.push(`✅ <b>Agenda abierta</b>`, ``);
    lines.push(`📅 ${day.label}s · ⏰ ${rangeM[1]}–${rangeM[2]} (≈${slots} cupos de 20 min)`);
    lines.push(`🗓️ ${startDate} → ${endDate}`);
    lines.push(`👥 Perfil(es): ${ok.join(" + ")}`);
  }
  if (failed.length > 0) {
    lines.push(``, `⚠️ No se pudo en: `);
    for (const f of failed) lines.push(`• ${escapeHtml(f)}`);
  }
  if (ok.length > 0) {
    lines.push(``, `<i>Los pacientes ya pueden agendar.</i>`);
  }
  return { reply: lines.join("\n") || "❌ No se creó ninguna agenda." };
}

function helpText(): string {
  return [
    "📋 <b>Abrir agenda (cupos)</b>",
    "",
    "<code>/abrir_agenda [perfil] &lt;día&gt; &lt;inicio&gt;-&lt;fin&gt; [desde] [hasta]</code>",
    "",
    "Ejemplos:",
    "<code>/abrir_agenda jueves 8:00-12:20</code> (ambos perfiles)",
    "<code>/abrir_agenda ninos jueves 8:00-12:20</code>",
    "<code>/abrir_agenda adultos lunes 7:00-13:00 01/07/2026 31/07/2026</code>",
    "",
    "• <b>Perfil</b> (opcional): <code>ninos</code> · <code>adultos</code> · <code>ambos</code> (default: ambos a la vez)",
    "• Slots de 20 min · agenda del Dr. Duque",
    "• Sin fechas = próximas 2 semanas",
    "• Días: lunes…domingo (o lun/mar/mié...)",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
