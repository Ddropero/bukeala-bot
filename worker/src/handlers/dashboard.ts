/**
 * GET /dashboard?token=<CAPTURE_TOKEN>
 *
 * Server-rendered single-page operational dashboard for Dr. Duque.
 * Shows live state in one glance and auto-refreshes every 30 seconds via
 * a `<meta http-equiv="refresh">` tag (no JS, no external resources).
 *
 * Sections:
 *   - Status bar: Bukeala session age + pending refresh request flag
 *   - 📅 Hoy:        today's agenda for AREA_ID 1074
 *   - 📅 Mañana:     tomorrow's agenda
 *   - 💬 WhatsApp:   up to 30 active contacts (sorted by lastSeenAt desc)
 *                    with mode badge (auto / manual / review)
 *   - 💰 Cotizaciones: pending quote tickets with age in hours
 *
 * All fetch failures degrade gracefully — a card that fails to load shows
 * an inline error instead of breaking the page. Bukeala session expiry is
 * surfaced as a friendly "expirada" warning in the affected sections.
 */
import type { Context } from "hono";
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";

// AREA_ID for the doctor's calendar — same constant used by /hoy and the
// daily summary cron.
const AREA_ID = 1074;

// Colombia is UTC-5 year-round (no DST). All "today/tomorrow" reasoning is
// anchored to Bogota local time.
const BOGOTA_OFFSET_MS = -5 * 3600 * 1000;

// Subset of the booking shape we render. Mirrors AgendaBooking in
// commands/agendaDetail.ts and dailySummary.ts.
type AgendaBooking = {
  name?: string;
  startHourFormatted?: string;
  stateCode?: string;
  stateDesc?: string;
  isCanceled?: boolean;
  isBusyTime?: boolean;
  bookingComponentName?: string;
};

type WaContact = {
  phone: string;
  name: string;
  lastSeenAt: number;
  mode: "auto" | "manual" | "review";
};

type QuoteTicket = {
  id: string;
  fromPhone: string;
  patientName: string;
  procedure?: string;
  status: "pending" | "quoted" | "accepted" | "rejected" | "expired";
  createdAt: number;
};

type RefreshRequest = {
  requestedAt: string;
  requestedBy: string;
  pickedUpAt?: string;
  completedAt?: string;
};

export async function handleDashboard(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 1. Auth — token must match (same as every other admin endpoint).
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // 2. Compute today + tomorrow in Bogota time, formatted as DD-MM-YYYY for
  //    the Bukeala /admin/daily endpoint.
  const nowMs = Date.now();
  const todayBogota = new Date(nowMs + BOGOTA_OFFSET_MS);
  const tomorrowBogota = new Date(todayBogota.getTime() + 24 * 3600 * 1000);
  const todayDashed = ddMmYyyy(todayBogota);
  const tomorrowDashed = ddMmYyyy(tomorrowBogota);

  // 3. Aggregate everything in parallel — independent fetches, so we don't
  //    serialize. Each piece has its own error swallow so one failure
  //    doesn't take down the page.
  const b = new Bukeala(c.env);
  const [
    sessionInfo,
    todayResult,
    tomorrowResult,
    contacts,
    quotes,
    refreshReq,
    pendingWa,
  ] = await Promise.all([
    loadSessionInfo(c.env),
    fetchAgenda(b, todayDashed),
    fetchAgenda(b, tomorrowDashed),
    listWaContacts(c.env),
    listPendingQuotes(c.env),
    loadRefreshRequest(c.env),
    countPendingWa(c.env),
  ]);

  // 4. Render. Hono's c.html() sets Content-Type: text/html; charset=UTF-8
  //    and accepts a string body. We forward the (already-validated) token
  //    into footer links so the admin endpoints they point to can be hit
  //    in one click.
  const token = c.req.query("token") ?? "";
  const html = renderHtml({
    sessionInfo,
    todayResult,
    tomorrowResult,
    contacts,
    quotes,
    refreshReq,
    pendingWa,
    nowBogota: todayBogota,
    token,
  });
  return c.html(html);
}

// =====================================================================
// Data loaders — each returns either data or a tagged error envelope so
// the renderer can show per-card fallbacks without throwing.
// =====================================================================

type AgendaResult =
  | { ok: true; bookings: AgendaBooking[] }
  | { ok: false; reason: "expired" | "error"; message?: string };

async function fetchAgenda(b: Bukeala, dateDashed: string): Promise<AgendaResult> {
  try {
    const res = await b.getAgenda(dateDashed, AREA_ID, /* includeCanceled */ false);
    type AgendaJson = { areas?: Array<{ bookings?: AgendaBooking[] }> };
    const json: AgendaJson | null = await res.json<AgendaJson>().catch(() => null);
    const bookings = json?.areas?.[0]?.bookings ?? [];
    // Filter out canceled + busy-time blocks for the dashboard view.
    const active = bookings.filter(
      (bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime,
    );
    // Stable sort by start time.
    active.sort((x, y) => timeKey(x.startHourFormatted ?? "") - timeKey(y.startHourFormatted ?? ""));
    return { ok: true, bookings: active };
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: "error", message: (e as Error).message };
  }
}

type SessionInfo =
  | { hasSession: true; ageMin: number; capturedAt: string }
  | { hasSession: false };

async function loadSessionInfo(env: Env): Promise<SessionInfo> {
  try {
    const s = await loadSession(env);
    if (!s || !s.capturedAt) return { hasSession: false };
    const captured = new Date(s.capturedAt).getTime();
    if (!Number.isFinite(captured)) return { hasSession: false };
    const ageMin = Math.max(0, Math.floor((Date.now() - captured) / 60000));
    return { hasSession: true, ageMin, capturedAt: s.capturedAt };
  } catch {
    return { hasSession: false };
  }
}

/**
 * List up to 30 most-recent WhatsApp contacts. KV.list returns key
 * metadata only (no values), so we batch-get values with Promise.all.
 *
 * KV.list is paginated — we fetch up to 200 keys and then trim to 30
 * after sorting by lastSeenAt desc, which keeps the dashboard responsive
 * even when there are hundreds of contacts.
 */
async function listWaContacts(env: Env): Promise<WaContact[]> {
  try {
    const list = await env.STATE.list({ prefix: "wa:contact:", limit: 200 });
    if (list.keys.length === 0) return [];

    // Fetch all the contact bodies in parallel, then enrich with mode.
    const enriched = await Promise.all(
      list.keys.map(async (k) => {
        const phone = k.name.slice("wa:contact:".length);
        const [contactRaw, mode] = await Promise.all([
          env.STATE.get(k.name),
          env.STATE.get(`wa:mode:${phone}`),
        ]);
        if (!contactRaw) return null;
        let parsed: { name?: string; lastSeenAt?: number };
        try { parsed = JSON.parse(contactRaw); } catch { return null; }
        const lastSeenAt = typeof parsed.lastSeenAt === "number" ? parsed.lastSeenAt : 0;
        const m = (mode === "auto" || mode === "review" || mode === "manual") ? mode : "manual";
        return {
          phone,
          name: (parsed.name || "").trim() || phone,
          lastSeenAt,
          mode: m as WaContact["mode"],
        } satisfies WaContact;
      }),
    );

    return enriched
      .filter((x): x is WaContact => x !== null)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 30);
  } catch (e) {
    console.log("[dashboard] listWaContacts failed:", (e as Error).message);
    return [];
  }
}

async function listPendingQuotes(env: Env): Promise<QuoteTicket[]> {
  try {
    const raw = await env.STATE.get("quote:pending:list");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Show only tickets that haven't been resolved yet (pending/quoted are
    // both "in progress" from the doctor's perspective).
    return arr
      .filter((t: QuoteTicket) => t && (t.status === "pending" || t.status === "quoted"))
      .sort((a: QuoteTicket, b: QuoteTicket) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } catch {
    return [];
  }
}

async function loadRefreshRequest(env: Env): Promise<RefreshRequest | null> {
  try {
    const raw = await env.STATE.get("nativeHost:refreshRequest");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RefreshRequest;
    return parsed;
  } catch {
    return null;
  }
}

async function countPendingWa(env: Env): Promise<number> {
  try {
    const raw = await env.STATE.get("wa:pending:list");
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// =====================================================================
// Renderer
// =====================================================================

interface RenderInput {
  sessionInfo: SessionInfo;
  todayResult: AgendaResult;
  tomorrowResult: AgendaResult;
  contacts: WaContact[];
  quotes: QuoteTicket[];
  refreshReq: RefreshRequest | null;
  pendingWa: number;
  nowBogota: Date;
  token: string;
}

function renderHtml(d: RenderInput): string {
  const updatedStr = formatBogotaTimestamp(d.nowBogota);
  const statusBar = renderStatusBar(d.sessionInfo, d.refreshReq, d.pendingWa);
  const todayCard = renderAgendaCard("📅 Hoy", d.todayResult);
  const tomorrowCard = renderAgendaCard("📅 Mañana", d.tomorrowResult);
  const contactsCard = renderContactsCard(d.contacts);
  const quotesCard = renderQuotesCard(d.quotes, d.nowBogota);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dr. Duque · Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  body { background: #f9fafb; color: #1f2937; padding: 16px; line-height: 1.4; }
  .container { max-width: 1200px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  h1 { color: #10b981; font-size: 22px; font-weight: 600; }
  header small { color: #6b7280; font-size: 12px; }
  .status-bar { background: white; border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 16px; display: flex; gap: 20px; flex-wrap: wrap; align-items: center; font-size: 14px; }
  .status-bar .pill { display: inline-flex; align-items: center; gap: 6px; }
  .status-bar .pill.warn { color: #92400e; }
  .status-bar .pill.error { color: #991b1b; }
  .status-bar .pill.ok { color: #065f46; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } body { padding: 12px; } }
  .card { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .card h2 { font-size: 16px; margin-bottom: 12px; color: #10b981; font-weight: 600; display: flex; justify-content: space-between; align-items: baseline; }
  .card h2 .count { color: #6b7280; font-size: 12px; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #6b7280; font-weight: 500; padding: 4px 6px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 6px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.time { font-variant-numeric: tabular-nums; color: #374151; white-space: nowrap; width: 1%; font-weight: 500; }
  td.name { font-weight: 500; }
  td.meta { color: #6b7280; font-size: 12px; white-space: nowrap; width: 1%; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
  .row:last-child { border-bottom: none; }
  .row .left { min-width: 0; flex: 1; }
  .row .right { color: #6b7280; font-size: 12px; white-space: nowrap; }
  .row .name { font-weight: 500; font-size: 14px; }
  .row .sub { font-size: 12px; color: #6b7280; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; vertical-align: middle; }
  .badge.auto { background: #d1fae5; color: #065f46; }
  .badge.manual { background: #fef3c7; color: #92400e; }
  .badge.review { background: #dbeafe; color: #1e40af; }
  .badge.pending { background: #fef3c7; color: #92400e; }
  .badge.quoted { background: #dbeafe; color: #1e40af; }
  .empty { color: #9ca3af; font-style: italic; padding: 12px 0; text-align: center; font-size: 13px; }
  .error-box { background: #fef2f2; color: #991b1b; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
  .warn-box { background: #fffbeb; color: #92400e; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
  footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; display: flex; gap: 16px; flex-wrap: wrap; }
  footer a { color: #10b981; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  /* Pestañas */
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 2px solid #e5e7eb; flex-wrap: wrap; }
  .tabs button { background: none; border: none; padding: 10px 16px; font-size: 15px; font-weight: 600; color: #6b7280; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tabs button.active { color: #10b981; border-bottom-color: #10b981; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  /* Formato Marly */
  .marly { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); max-width: 800px; margin: 0 auto; }
  .marly-title { text-align: center; font-weight: 700; font-size: 15px; color: #111827; }
  .marly-sub { text-align: center; font-size: 12px; color: #6b7280; margin-bottom: 14px; }
  .marly table { width: 100%; border-collapse: collapse; }
  .marly td { border: 1px solid #d1d5db; padding: 0; vertical-align: top; }
  .marly td.lbl { background: #f3f4f6; font-size: 11px; font-weight: 600; text-transform: uppercase; color: #374151; padding: 8px; width: 40%; }
  .marly input, .marly textarea { width: 100%; border: none; padding: 8px; font-size: 14px; font-family: inherit; background: transparent; color: #111827; resize: vertical; }
  .marly textarea { min-height: 40px; }
  .marly input:focus, .marly textarea:focus { outline: 2px solid #10b981; outline-offset: -2px; }
  .marly-note { font-size: 11px; color: #991b1b; margin-top: 12px; font-style: italic; }
  .marly-actions { display: flex; gap: 10px; margin: 4px 0 16px; flex-wrap: wrap; align-items: center; }
  .marly-actions button { padding: 12px 18px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .btn-print { background: #10b981; color: white; }
  .btn-clear { background: #f3f4f6; color: #374151; }
  .saved-hint { font-size: 12px; color: #9ca3af; }
  /* Impresión: solo el formato Marly, limpio */
  @media print {
    body { padding: 0; background: white; }
    .tabs, header, footer, .no-print { display: none !important; }
    .tab-panel:not(.active) { display: none !important; }
    #tab-dashboard { display: none !important; }
    .marly { box-shadow: none; border-radius: 0; padding: 0; max-width: none; }
    .marly input, .marly textarea { outline: none !important; }
    .marly td.lbl { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { size: A4 portrait; margin: 12mm; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🩺 Dr. Duque · Dashboard</h1>
    <small>Actualizado ${esc(updatedStr)} · auto-refresh 30s</small>
  </header>
  <div class="tabs">
    <button data-tab="dashboard" class="active" onclick="showTab('dashboard')">📊 Dashboard</button>
    <button data-tab="marly" onclick="showTab('marly')">🏥 Programación Marly</button>
  </div>
  <div id="tab-dashboard" class="tab-panel active">
    ${statusBar}
    <div class="grid">
      ${todayCard}
      ${tomorrowCard}
      ${contactsCard}
      ${quotesCard}
    </div>
  </div>
  <div id="tab-marly" class="tab-panel">
    ${marlyTabHtml()}
  </div>
  <footer>
    <span>AREA_ID ${AREA_ID}</span>
    <a href="/sesion/renew?token=${encodeURIComponent(d.token)}">↻ Renovar sesión</a>
    <a href="/debug/state?token=${encodeURIComponent(d.token)}">🔧 KV state</a>
  </footer>
</div>
<script>
function showTab(t){
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.toggle('active', p.id==='tab-'+t); });
  document.querySelectorAll('.tabs button').forEach(function(b){ b.classList.toggle('active', b.dataset.tab===t); });
  try{ localStorage.setItem('dashTab', t); }catch(e){}
}
(function(){
  try{ var t=localStorage.getItem('dashTab'); if(t) showTab(t); }catch(e){}
  var MK='marlyForm_v1';
  var hint=document.getElementById('savedHint');
  function fields(){ return document.querySelectorAll('#tab-marly [data-f]'); }
  function save(){ var d={}; fields().forEach(function(el){ d[el.getAttribute('data-f')]=el.value; }); try{ localStorage.setItem(MK, JSON.stringify(d)); if(hint) hint.textContent='Guardado ✓'; }catch(e){} }
  function load(){ try{ var d=JSON.parse(localStorage.getItem(MK)||'{}'); fields().forEach(function(el){ var k=el.getAttribute('data-f'); if(d[k]!=null) el.value=d[k]; }); }catch(e){} }
  window.clearMarly=function(){ if(!confirm('¿Limpiar todo el formato?')) return; fields().forEach(function(el){ el.value=''; }); try{ localStorage.removeItem(MK); }catch(e){} if(hint) hint.textContent='Limpiado'; };
  fields().forEach(function(el){ el.addEventListener('input', save); });
  load();
  // Auto-refresh controlado: recarga cada 30s SOLO en Dashboard y si no estás
  // escribiendo, para no borrar el formulario de Marly.
  setInterval(function(){
    var onDash=(localStorage.getItem('dashTab')||'dashboard')==='dashboard';
    var typing=document.activeElement && ['INPUT','TEXTAREA'].indexOf(document.activeElement.tagName)>=0;
    if(onDash && !typing) location.reload();
  }, 30000);
})();
</script>
</body>
</html>`;
}

/** Pestaña "Programación Marly": formato llenable + imprimir/guardar PDF. */
function marlyTabHtml(): string {
  const fields: Array<[string, string, "text" | "textarea"]> = [
    ["paciente", "Nombres y apellidos del paciente", "text"],
    ["identificacion", "Identificación", "text"],
    ["edad", "Edad en años", "text"],
    ["telefono", "Teléfono del paciente", "text"],
    ["asegurador", "Asegurador", "text"],
    ["autorizacion", "Autorización por asegurador", "text"],
    ["procedimiento", "Nombre del procedimiento", "textarea"],
    ["fecha", "Fecha del procedimiento", "text"],
    ["hora", "Hora del procedimiento", "text"],
    ["tiempo", "Tiempo quirúrgico", "text"],
    ["cirujano", "Cirujano tratante", "text"],
    ["ayudante", "Ayudante especialista o médico", "text"],
    ["anestesia", "Tipo de anestesia", "text"],
    ["hospitalizacion", "Hospitalizado vs ambulatorio", "text"],
    ["insumos", "Insumos especiales y casa comercial", "textarea"],
    ["equipos", "Equipos especiales y casa comercial", "textarea"],
    ["uci", "Necesidad de UCI POP", "text"],
    ["antMetab", "Antecedentes metabólicos", "textarea"],
    ["antCardio", "Antecedentes cardiovasculares", "textarea"],
    ["antOtros", "Otros antecedentes importantes", "textarea"],
    ["sintResp", "Síntomas respiratorios", "textarea"],
    ["vacuna", "Vacuna (esquema)", "text"],
  ];
  const rows = fields.map(([k, label, type]) => {
    const input = type === "textarea"
      ? `<textarea data-f="${k}" rows="2"></textarea>`
      : `<input data-f="${k}" type="text" autocomplete="off">`;
    return `<tr><td class="lbl">${label}</td><td>${input}</td></tr>`;
  }).join("");
  return `<div class="marly">
    <div class="marly-title">FORMATO DE PROGRAMACIÓN · SALAS DE CIRUGÍA</div>
    <div class="marly-sub">CLÍNICA DE MARLY S.A.</div>
    <div class="marly-actions no-print">
      <button class="btn-print" onclick="window.print()">🖨️ Guardar / Imprimir PDF</button>
      <button class="btn-clear" onclick="clearMarly()">🗑️ Limpiar</button>
      <span class="saved-hint" id="savedHint">Se guarda solo en este celular ✓</span>
    </div>
    <table><tbody>${rows}</tbody></table>
    <div class="marly-note">*Recuerde que los insumos y equipos especiales deben ser ingresados exclusivamente mediante cumplimiento de protocolos institucionales; no está autorizado su ingreso por el paciente ni por el especialista.</div>
  </div>`;
}

function renderStatusBar(s: SessionInfo, refresh: RefreshRequest | null, pendingWa: number): string {
  const sessionPill = s.hasSession
    ? `<span class="pill ok">🟢 Bukeala viva (${s.ageMin}min)</span>`
    : `<span class="pill error">🔴 Bukeala expirada — renueva la sesión</span>`;

  const refreshPill = refresh
    ? `<span class="pill warn">🔄 Refresh solicitado ${formatRelative(refresh.requestedAt)}${refresh.pickedUpAt ? ` (recogido)` : ""}</span>`
    : "";

  const pendingPill = pendingWa > 0
    ? `<span class="pill warn">📥 ${pendingWa} pendiente${pendingWa === 1 ? "" : "s"} en cola WA</span>`
    : "";

  return `<div class="status-bar">${sessionPill}${refreshPill}${pendingPill}</div>`;
}

function renderAgendaCard(title: string, r: AgendaResult): string {
  if (!r.ok && r.reason === "expired") {
    return `<div class="card">
      <h2>${esc(title)}</h2>
      <div class="warn-box">⚠️ Bukeala expirada — renueva la sesión</div>
    </div>`;
  }
  if (!r.ok) {
    return `<div class="card">
      <h2>${esc(title)}</h2>
      <div class="error-box">Error: ${esc(r.message ?? "desconocido")}</div>
    </div>`;
  }
  if (r.bookings.length === 0) {
    return `<div class="card">
      <h2>${esc(title)} <span class="count">0 citas</span></h2>
      <div class="empty">Sin citas agendadas</div>
    </div>`;
  }
  const rows = r.bookings.map((bk) => {
    const time = (bk.startHourFormatted ?? "").trim() || "—";
    const name = (bk.name ?? "").trim() || "(sin nombre)";
    const proc = (bk.bookingComponentName ?? "").trim();
    const state = (bk.stateDesc ?? bk.stateCode ?? "").trim();
    return `<tr>
      <td class="time">${esc(time)}</td>
      <td class="name">${esc(name)}${proc ? `<div class="sub" style="color:#6b7280;font-size:11px;font-weight:400;">${esc(proc)}</div>` : ""}</td>
      <td class="meta">${esc(state)}</td>
    </tr>`;
  }).join("");

  return `<div class="card">
    <h2>${esc(title)} <span class="count">${r.bookings.length} cita${r.bookings.length === 1 ? "" : "s"}</span></h2>
    <table>
      <thead><tr><th>Hora</th><th>Paciente</th><th>Estado</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderContactsCard(contacts: WaContact[]): string {
  if (contacts.length === 0) {
    return `<div class="card">
      <h2>💬 WhatsApp Activos <span class="count">0</span></h2>
      <div class="empty">Sin contactos recientes</div>
    </div>`;
  }
  const items = contacts.map((c) => {
    const badge = modeBadge(c.mode);
    const rel = formatRelativeMs(c.lastSeenAt);
    return `<div class="row">
      <div class="left">
        <div class="name">${esc(c.name)} ${badge}</div>
        <div class="sub">+${esc(c.phone)}</div>
      </div>
      <div class="right">${esc(rel)}</div>
    </div>`;
  }).join("");

  return `<div class="card">
    <h2>💬 WhatsApp Activos <span class="count">${contacts.length}</span></h2>
    ${items}
  </div>`;
}

function renderQuotesCard(quotes: QuoteTicket[], now: Date): string {
  if (quotes.length === 0) {
    return `<div class="card">
      <h2>💰 Cotizaciones <span class="count">0</span></h2>
      <div class="empty">Sin cotizaciones pendientes</div>
    </div>`;
  }
  const nowMs = now.getTime() - BOGOTA_OFFSET_MS; // back to UTC
  const items = quotes.map((q) => {
    const ageHours = q.createdAt ? Math.max(0, Math.floor((nowMs - q.createdAt) / 3600000)) : 0;
    const ageStr = ageHours < 1 ? "< 1h" : ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d`;
    const statusBadge = q.status === "quoted"
      ? `<span class="badge quoted">cotizado</span>`
      : `<span class="badge pending">pendiente</span>`;
    return `<div class="row">
      <div class="left">
        <div class="name">${esc(q.patientName || "(sin nombre)")} ${statusBadge}</div>
        <div class="sub">${esc(q.procedure || "—")} · +${esc(q.fromPhone)}</div>
      </div>
      <div class="right">${esc(ageStr)}</div>
    </div>`;
  }).join("");

  return `<div class="card">
    <h2>💰 Cotizaciones <span class="count">${quotes.length}</span></h2>
    ${items}
  </div>`;
}

function modeBadge(mode: WaContact["mode"]): string {
  if (mode === "auto") return `<span class="badge auto">🤖 auto</span>`;
  if (mode === "review") return `<span class="badge review">👁️ review</span>`;
  return `<span class="badge manual">✋ manual</span>`;
}

// =====================================================================
// Helpers
// =====================================================================

function ddMmYyyy(d: Date): string {
  // Caller already shifted to Bogota — read UTC fields.
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatBogotaTimestamp(d: Date): string {
  // d is already in Bogota local via UTC accessors.
  const dd = pad2(d.getUTCDate());
  const mm = pad2(d.getUTCMonth() + 1);
  const yyyy = d.getUTCFullYear();
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function formatRelativeMs(timestampMs: number): string {
  if (!timestampMs) return "—";
  const diffMs = Date.now() - timestampMs;
  if (diffMs < 0) return "ahora";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "?";
  return `hace ${formatRelativeMs(t)}`;
}

/** Convert "08:00 AM" → minutes since midnight, NaN-safe (returns 0). */
function timeKey(formatted: string): number {
  const m = formatted.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const isPm = m[3].toUpperCase() === "PM";
  if (h === 12) h = 0;
  if (isPm) h += 12;
  return h * 60 + min;
}

/** HTML-escape user-controlled strings before interpolation into the page. */
function esc(s: string | undefined | null): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

