/**
 * Aviso ANTES de que venza la sesión de Bukeala (pedido del Dr., 19-nov-2026).
 *
 * Colsanitas corta la sesión unas horas después de cada login humano (medido:
 * 316 min casi siempre; 17-nov-2026 ~358 min) y Radware impide que la VM se
 * vuelva a loguear sola. Lo único que evita la caída es que el Dr. se loguee
 * antes, así que se le avisa 30 min antes por Telegram y WhatsApp.
 *
 * Cómo se sabe cuándo fue el login: la cookie TGC del CAS cambia SOLO con un
 * login nuevo (la VM y la extensión republican la misma). El keepAlive, cuando
 * comprueba que la sesión sirve, compara la huella del TGC con las conocidas.
 *
 * Silencio 9 p. m. – 6 a. m. (Bogotá): de noche no se avisa; el aviso que
 * tocaba sale a las 6 a. m. (o "venció anoche" si ya murió). No hay "última
 * llamada" antes de las 9 p. m.: loguearse de noche no deja la sesión viva
 * hasta la mañana (dura ~5-6 h), así que el aviso útil es el de las 6 a. m.
 *
 * Un solo aviso por login. Si después muere sin login nuevo, las alertas de
 * caída que ya existían (keepAlive/watchdog) siguen su curso.
 *
 * KV:
 *   session:loginWatch     → {logins: [{fp, loginAt, exact, diedAt?, notifiedAt?, kind?, sampled?, sampleMin?}]} últimos 3 (TTL 3d)
 *   stats:loginLifetimes   → minutos que vivió cada login (últimos 10, TTL 90d)
 */
import type { Env } from "../env";
import { getDoctorRecipients } from "../users";
import { normalizeColombianPhone, sendTemplate, sendText } from "../whatsapp";

const WATCH_KEY = "session:loginWatch";
const LIFETIMES_KEY = "stats:loginLifetimes";
const MINUTE = 60_000;
export const DEFAULT_LIFE_MIN = 316;
export const WARN_BEFORE_MIN = 30;
/** La sesión a veces fluctúa 200/302: una muerte cuenta tras 10 min seguidos. */
const DEATH_CONFIRM_MIN = 10;
/**
 * Lejos de la hora esperada, una caída suele ser solo el JSESSIONID del Worker
 * y la VM lo repone con el mismo TGC: se espera más antes de decir "venció".
 */
const EARLY_DEATH_CONFIRM_MIN = 30;
/** Una caída antes de esto no es el vencimiento del login: no cuenta como medida de vida. */
const MIN_SAMPLE_MIN = 280;
const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 6;

export type NoticeKind = "pre" | "overdue" | "dead";
export type Notice = { kind: NoticeKind; at: number };
export type LoginWatch = {
  fp: string;
  loginAt: number;
  /** false = loginAt es aproximado (primer registro, sin login anterior con qué comparar). */
  exact: boolean;
  diedAt?: number;
  notifiedAt?: number;
  kind?: NoticeKind;
  sampled?: boolean;
  /** Medida guardada en stats:loginLifetimes por esta muerte (para deshacerla). */
  sampleMin?: number;
};
/**
 * Se recuerdan los últimos logins, no solo uno: tras un relogueo anticipado
 * conviven dos TGC vivos (la VM sigue publicando el viejo hasta que muere y la
 * extensión publica el nuevo) y la sesión guardada alterna entre ambos. Volver
 * a ver un TGC conocido NO es un login nuevo. El reloj sigue al más reciente.
 */
type WatchState = { logins: LoginWatch[] };
type CookieLike = { name: string; value: string };

/** Bogotá es UTC-5 fijo (sin horario de verano). */
function bogota(now: number): Date {
  return new Date(now - 5 * 3600 * 1000);
}

export function isQuietHour(now: number): boolean {
  const h = bogota(now).getUTCHours();
  return h >= QUIET_FROM_HOUR || h < QUIET_UNTIL_HOUR;
}

/** "5:50 p. m." en hora de Bogotá. */
export function formatBogotaTime(at: number): string {
  const d = bogota(at);
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "a. m." : "p. m."}`;
}

/** Huella del TGC (nunca se guarda el valor de la cookie). null si no hay TGC. */
export async function tgcFingerprint(cookies: CookieLike[]): Promise<string | null> {
  const tgc = cookies.find((c) => /^(CAS)?TGC/i.test(c.name) && c.value);
  if (!tgc) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tgc.value));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Vida estimada de un login. Conservadora a propósito: avisar temprano no
 * cuesta nada (loguearse antes reemplaza la sesión), avisar tarde no sirve.
 * Con menos de 3 medidas manda el default histórico; con 3+ el mínimo reciente.
 * Solo cuentan medidas de 280+ min: menos que eso fue una caída, no el vencimiento.
 */
export function estimateLifeMin(samples: number[]): number {
  const recent = samples.filter((n) => Number.isFinite(n) && n >= MIN_SAMPLE_MIN && n <= 720).slice(-5);
  if (recent.length >= 3) return Math.min(...recent);
  return Math.min(DEFAULT_LIFE_MIN, ...recent);
}

/** Decisión pura: ¿toca avisar ahora y qué? */
export function decideExpiryNotice(watch: LoginWatch | null, lifeMin: number, now: number): Notice | null {
  if (!watch || watch.notifiedAt) return null;
  if (isQuietHour(now)) return null;
  const expected = watch.loginAt + lifeMin * MINUTE;
  const warnAt = expected - WARN_BEFORE_MIN * MINUTE;
  if (watch.diedAt) {
    // Muerte sin confirmar (parpadeo 200/302, o la VM a punto de reponer): esperar.
    const confirmMin = watch.diedAt >= warnAt ? DEATH_CONFIRM_MIN : EARLY_DEATH_CONFIRM_MIN;
    return now - watch.diedAt >= confirmMin * MINUTE ? { kind: "dead", at: watch.diedAt } : null;
  }
  if (now < warnAt) return null;
  return { kind: now >= expected ? "overdue" : "pre", at: expected };
}

export function noticeText(notice: Notice, now: number): { titulo: string; detalle: string } {
  const comoEntrar = "Entra al portal desde el PC, o desde el iPhone por Chrome Remote Desktop, y loguéate.";
  if (notice.kind === "pre") {
    return {
      titulo: `Tu sesión de Bukeala vence hacia las ${formatBogotaTime(notice.at)}`,
      detalle: `${comoEntrar} Si lo haces antes de esa hora, el bot no se cae.`,
    };
  }
  if (notice.kind === "overdue") {
    return {
      titulo: "Tu sesión de Bukeala puede vencer en cualquier momento",
      detalle: `Ya pasó la hora en que suele vencer (${formatBogotaTime(notice.at)}). ${comoEntrar}`,
    };
  }
  const dia = (ms: number) => Math.floor((ms - 5 * 3600 * 1000) / 86_400_000); // día calendario en Bogotá
  const hora = bogota(notice.at).getUTCHours();
  const dias = dia(now) - dia(notice.at);
  const cuando = dias <= 0
    ? (hora < QUIET_UNTIL_HOUR ? "esta madrugada" : "hoy")
    : dias === 1 ? (hora >= 18 ? "anoche" : "ayer") : "hace días";
  return {
    titulo: `Tu sesión de Bukeala venció ${cuando} a las ${formatBogotaTime(notice.at)}`,
    detalle: `El bot no puede consultar la agenda hasta que te loguees. ${comoEntrar}`,
  };
}

async function readState(env: Env): Promise<WatchState> {
  try {
    const raw = await env.STATE.get(WATCH_KEY);
    const st = raw ? (JSON.parse(raw) as Partial<WatchState>) : null;
    const logins = Array.isArray(st?.logins)
      ? st.logins.filter((w) => w && typeof w.fp === "string" && Number.isFinite(w.loginAt))
      : [];
    return { logins };
  } catch { return { logins: [] }; }
}

async function saveState(env: Env, state: WatchState): Promise<void> {
  const logins = [...state.logins].sort((a, b) => a.loginAt - b.loginAt).slice(-3);
  await env.STATE.put(WATCH_KEY, JSON.stringify({ logins }), { expirationTtl: 60 * 60 * 24 * 3 });
}

/** El login vigente: el más reciente conocido. */
function newest(state: WatchState): LoginWatch | null {
  return state.logins.reduce<LoginWatch | null>((best, w) => (!best || w.loginAt > best.loginAt ? w : best), null);
}

async function readLifetimes(env: Env): Promise<number[]> {
  try {
    const parsed: unknown = JSON.parse((await env.STATE.get(LIFETIMES_KEY)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch { return []; }
}

/**
 * Ese login volvió a servir: no había muerto (parpadeo 200/302, o murió solo
 * el JSESSIONID del Worker y la VM publicó otro). Se deshace la "muerte":
 * fuera la medida de vida falsa y el aviso de "venció", para que el aviso
 * previo de ese login todavía pueda salir.
 */
async function undoDeath(env: Env, login: LoginWatch): Promise<void> {
  if (login.sampleMin !== undefined) {
    const lifes = await readLifetimes(env);
    const i = lifes.lastIndexOf(login.sampleMin);
    if (i >= 0) {
      lifes.splice(i, 1);
      await env.STATE.put(LIFETIMES_KEY, JSON.stringify(lifes), { expirationTtl: 60 * 60 * 24 * 90 });
    }
  }
  delete login.diedAt; delete login.sampled; delete login.sampleMin;
  if (login.kind === "dead") { delete login.notifiedAt; delete login.kind; }
}

/**
 * El keepAlive comprobó que la sesión guardada SIRVE. TGC nunca visto = login
 * nuevo → reloj nuevo. TGC conocido = no cambia nada (salvo deshacer una
 * muerte que no era tal).
 */
export async function recordAliveSession(
  env: Env,
  session: { cookies: CookieLike[]; capturedAt: string },
  now = Date.now(),
): Promise<void> {
  const fp = await tgcFingerprint(session.cookies);
  const state = await readState(env);
  // Sin TGC no se sabe de qué login es; si sirve, el vigente no está muerto.
  const known = fp ? state.logins.find((w) => w.fp === fp) : newest(state);
  if (known) {
    if (!known.diedAt) return;
    await undoDeath(env, known);
    await saveState(env, state);
    return;
  }
  if (!fp) return;
  const captured = Date.parse(session.capturedAt);
  state.logins.push({
    fp,
    loginAt: Number.isFinite(captured) ? Math.min(now, captured) : now,
    // Sin registro anterior no se sabe si el login es de ahora o de hace horas
    // (la VM republica y renueva capturedAt cada 10 min).
    exact: state.logins.length > 0,
  });
  await saveState(env, state);
}

/**
 * El keepAlive vio la sesión guardada rechazada por Bukeala (no un 5xx ni la
 * red). Se anota en el login al que pertenece esa sesión; si es uno viejo ya
 * reemplazado, el reloj del vigente no se toca.
 */
export async function recordSessionDeath(
  env: Env,
  session: { cookies: CookieLike[] } | null,
  now = Date.now(),
): Promise<void> {
  const state = await readState(env);
  const fp = session ? await tgcFingerprint(session.cookies) : null;
  const target = fp ? state.logins.find((w) => w.fp === fp) : newest(state);
  if (!target || target.diedAt) return;
  target.diedAt = now;
  await saveState(env, state);
}

async function sendTelegram(env: Env, html: string): Promise<void> {
  for (const chat of await getDoctorRecipients(env)) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML" }),
    }).catch(() => {});
  }
}

/** Corre con cada keepAlive (cada 3 min). */
export async function sessionExpiryNotice(env: Env, now = Date.now()): Promise<Notice | null> {
  const state = await readState(env);
  const watch = newest(state);
  if (!watch) return null;
  const lifeMin = estimateLifeMin(await readLifetimes(env));

  // Muerte confirmada: guardar cuánto vivió este login (solo si loginAt es
  // fiable y murió cerca del vencimiento, no por una caída a mitad de vida).
  if (watch.diedAt && !watch.sampled && now - watch.diedAt >= EARLY_DEATH_CONFIRM_MIN * MINUTE) {
    watch.sampled = true;
    const lived = Math.round((watch.diedAt - watch.loginAt) / MINUTE);
    const fiable = watch.exact && lived >= MIN_SAMPLE_MIN && lived <= 720;
    if (fiable) watch.sampleMin = lived;
    await saveState(env, state);
    if (fiable) {
      const lifes = await readLifetimes(env);
      lifes.push(lived);
      await env.STATE.put(LIFETIMES_KEY, JSON.stringify(lifes.slice(-10)), { expirationTtl: 60 * 60 * 24 * 90 });
    }
  }

  const notice = decideExpiryNotice(watch, lifeMin, now);
  if (!notice) return null;

  // Se marca ANTES de enviar: como mucho un aviso por login, aunque un envío falle.
  watch.notifiedAt = now;
  watch.kind = notice.kind;
  await saveState(env, state);

  const { titulo, detalle } = noticeText(notice, now);
  const icon = notice.kind === "dead" ? "🔴" : "⏳";
  try { await sendTelegram(env, `${icon} <b>${titulo}</b>\n\n${detalle}`); } catch (e) {
    console.log("[expiry-notice] Telegram falló:", (e as Error).message);
  }
  const to = normalizeColombianPhone(env.DOCTOR_WHATSAPP_NUMBER ?? "");
  if (to.length >= 10) {
    try {
      // Plantilla directa, no texto libre: es un aviso que inicia el bot y,
      // fuera de la ventana de 24 h, Meta ACEPTA el texto libre (HTTP 200) y
      // lo descarta después, así que un fallback a plantilla nunca saltaría.
      const r = await sendTemplate(env, to, "recordatorio_personal", "es_CO", [
        { type: "text", text: titulo.slice(0, 200) },
        { type: "text", text: detalle.replace(/[\n\r\t]+/g, " ").slice(0, 600) },
      ]);
      if (r.ok) {
        console.log("[expiry-notice] WhatsApp enviado (plantilla)");
      } else {
        // Plantilla rechazada (no aprobada, pausada…): último recurso, texto
        // libre, que solo llega si el Dr. escribió al número en las últimas 24 h.
        console.log(`[expiry-notice] plantilla falló (${r.status ?? "?"}: ${JSON.stringify(r.data?.error ?? {}).slice(0, 200)}) → texto libre`);
        const txt = await sendText(env, to, `${icon} ${titulo}\n\n${detalle}`);
        console.log(`[expiry-notice] WhatsApp texto libre ${txt.ok ? "aceptado" : `falló (${txt.status ?? "?"})`}`);
      }
    } catch (e) {
      console.log("[expiry-notice] WhatsApp falló:", (e as Error).message);
    }
  }
  console.log(`[expiry-notice] aviso ${notice.kind} enviado`);
  return notice;
}
