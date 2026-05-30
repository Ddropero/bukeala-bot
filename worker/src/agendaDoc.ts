/**
 * Build a self-contained HTML document with tomorrow's agenda for the
 * secretary. Opens in any browser (mobile or desktop) — works as a
 * WhatsApp/Telegram attachment.
 *
 * Columns: hora, paciente, cédula, teléfono, plan, estado.
 */

export type AgendaBookingDoc = {
  id?: number | string;
  startHourFormatted?: string;
  endHourFormatted?: string;
  name?: string;
  identification?: string;
  identificationTypeShortCode?: string;
  stateCode?: string;
  stateDesc?: string;
  isCanceled?: boolean;
  isBusyTime?: boolean;
  bookingComponentName?: string;
  planName?: string;
  phone?: string;
  cellPhone?: string | { phoneNumber?: string } | null;
  customerPhone?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractPhone(bk: AgendaBookingDoc): string {
  if (typeof bk.cellPhone === "string" && bk.cellPhone.trim()) return bk.cellPhone.trim();
  if (
    bk.cellPhone &&
    typeof bk.cellPhone === "object" &&
    typeof (bk.cellPhone as { phoneNumber?: string }).phoneNumber === "string"
  ) {
    return ((bk.cellPhone as { phoneNumber?: string }).phoneNumber ?? "").trim();
  }
  if (typeof bk.phone === "string" && bk.phone.trim()) return bk.phone.trim();
  if (typeof bk.customerPhone === "string" && bk.customerPhone.trim()) return bk.customerPhone.trim();
  return "";
}

function timeKey(formatted: string): number {
  const m = formatted.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h === 12) h = 0;
  if (m[3].toUpperCase() === "PM") h += 12;
  return h * 60 + min;
}

export function buildAgendaHtml(
  bookings: AgendaBookingDoc[],
  friendlyDate: string,
  confirmMap: Record<string, "si" | "no"> = {},
): string {
  const active = bookings
    .filter((bk) => !bk.isCanceled && bk.stateCode !== "CANCELED" && !bk.isBusyTime)
    .sort((a, b) => timeKey(a.startHourFormatted ?? "") - timeKey(b.startHourFormatted ?? ""));

  const rows = active
    .map((bk, i) => {
      const time = escapeHtml(bk.startHourFormatted ?? "—");
      const name = escapeHtml(bk.name ?? "—");
      const idType = bk.identificationTypeShortCode ?? "C";
      const idNum = escapeHtml(bk.identification ?? "—");
      const rawPhone = extractPhone(bk);
      // Teléfono como link tel: → tap-to-call desde el móvil de la asistente.
      const phoneCell = rawPhone
        ? `<a href="tel:${escapeHtml(rawPhone.replace(/[^\d+]/g, ""))}">${escapeHtml(rawPhone)}</a>`
        : "—";
      const plan = escapeHtml(bk.planName ?? "—");
      const state = escapeHtml(bk.stateDesc ?? bk.stateCode ?? "—");
      // Estado de confirmación por WhatsApp (botón del paciente)
      const cf = confirmMap[String(bk.id ?? "")];
      const confirmCell =
        cf === "si" ? `<span class="ok">✅ Sí (WA)</span>`
        : cf === "no" ? `<span class="bad">❌ No (WA)</span>`
        : `<span class="pend">☐ llamar</span>`;
      const rowClass = cf === "si" ? ' class="r-ok"' : cf === "no" ? ' class="r-bad"' : "";
      return `
      <tr${rowClass}>
        <td class="num">${i + 1}</td>
        <td class="time">${time}</td>
        <td class="name">${name}</td>
        <td class="id">${idType} ${idNum}</td>
        <td class="phone">${phoneCell}</td>
        <td class="plan">${plan}</td>
        <td class="state">${state}</td>
        <td class="check">${confirmCell}</td>
      </tr>`;
    })
    .join("");

  const bodyContent = active.length === 0
    ? `<p class="empty">Sin citas agendadas para esta fecha.</p>`
    : `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Hora</th>
          <th>Paciente</th>
          <th>Identificación</th>
          <th>Teléfono</th>
          <th>Plan</th>
          <th>Estado</th>
          <th>✓ Confirmó</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agenda ${escapeHtml(friendlyDate)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 16px; color: #1a1a1a; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #666; margin: 0 0 16px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  th { background: #f5f7fa; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; color: #555; }
  tr:nth-child(even) td { background: #fafafa; }
  td.num { color: #999; width: 28px; }
  td.time { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
  td.name { font-weight: 500; }
  td.phone { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.phone a { color: #1565c0; text-decoration: none; font-weight: 600; }
  td.check { text-align: center; white-space: nowrap; font-size: 12px; }
  td.check .ok { color: #2e7d32; font-weight: 600; }
  td.check .bad { color: #c62828; font-weight: 600; }
  td.check .pend { color: #999; }
  tr.r-ok td { background: #f1f8e9 !important; }
  tr.r-bad td { background: #ffebee !important; }
  .empty { padding: 24px; text-align: center; color: #888; border: 1px dashed #ddd; border-radius: 8px; }
  .banner { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 12px 14px; margin: 0 0 16px; font-size: 13px; color: #5d4037; }
  .banner b { color: #e65100; }
  .foot { color: #999; font-size: 11px; margin-top: 24px; }
</style>
</head>
<body>
  <h1>Agenda · ${escapeHtml(friendlyDate)}</h1>
  <p class="sub">${active.length} ${active.length === 1 ? "cita" : "citas"} para mañana</p>
  ${active.length > 0 ? `<div class="banner">📞 <b>Llamar a los que dicen "☐ llamar".</b> Los marcados <b>✅ Sí (WA)</b> ya confirmaron por WhatsApp — no hace falta llamarlos. Los <b>❌ No (WA)</b> avisaron que no pueden: reagendar. Toca el teléfono para llamar directo.</div>` : ""}
  ${bodyContent}
  <p class="foot">Generado automáticamente por el bot — Dr. Duque.</p>
</body>
</html>`;
}
