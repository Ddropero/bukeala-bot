/**
 * Generador de PDF mínimo y sin dependencias, para la agenda de la secretaria.
 *
 * ¿Por qué existe? WhatsApp RECHAZA `text/html` como documento (probado:
 * "Param file must be a file with one of the following types… Received file of
 * type 'text/html'"), y para enviar la agenda FUERA de la ventana de 24h hace
 * falta una plantilla con cabecera de DOCUMENTO. De los tipos que Meta acepta,
 * el PDF es el único que se ve decente en el celular.
 *
 * Alcance a propósito pequeño: texto en Helvetica, varias páginas si hace
 * falta. Nada de tablas ni imágenes — es una lista para llamar por teléfono.
 */

const PAGE_W = 595.28;   // A4 en puntos
const PAGE_H = 841.89;
const MARGIN = 48;
const LINE_H = 16;
const FONT_SIZE = 11;
const TITLE_SIZE = 15;
const MAX_LINES = Math.floor((PAGE_H - MARGIN * 2) / LINE_H) - 2;

/** Texto → bytes Latin-1 escapados para una cadena literal de PDF. */
function pdfEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\" + ch;
    else if (code < 32) out += " ";
    else if (code < 127) out += ch;
    else if (code < 256) out += "\\" + code.toString(8).padStart(3, "0");
    else {
      // Fuera de Latin-1 (emoji, etc.): se omite. El PDF es para leer y llamar.
      out += "";
    }
  }
  return out;
}

type Line = { text: string; bold?: boolean; size?: number };

function contentStream(lines: Line[]): string {
  let y = PAGE_H - MARGIN;
  const parts: string[] = ["BT"];
  let first = true;
  for (const ln of lines) {
    const size = ln.size ?? FONT_SIZE;
    const font = ln.bold ? "/F2" : "/F1";
    if (first) {
      parts.push(`${font} ${size} Tf`, `1 0 0 1 ${MARGIN} ${y} Tm`);
      first = false;
    } else {
      y -= LINE_H;
      parts.push(`${font} ${size} Tf`, `1 0 0 1 ${MARGIN} ${y} Tm`);
    }
    parts.push(`(${pdfEscape(ln.text)}) Tj`);
  }
  parts.push("ET");
  return parts.join("\n");
}

/**
 * Construye el PDF. `lines` ya viene formateado (una entrada por renglón).
 * Devuelve los bytes listos para subir a la Cloud API.
 */
export function buildAgendaPdf(title: string, lines: Line[]): Uint8Array {
  // Paginar
  const pages: Line[][] = [];
  const all: Line[] = [{ text: title, bold: true, size: TITLE_SIZE }, { text: "" }, ...lines];
  for (let i = 0; i < all.length; i += MAX_LINES) {
    pages.push(all.slice(i, i + MAX_LINES));
  }
  if (pages.length === 0) pages.push([{ text: title, bold: true, size: TITLE_SIZE }]);

  // Objetos: 1=Catalog, 2=Pages, 3=F1, 4=F2, luego por página: Page + Contents
  const objects: string[] = [];
  const pageObjIds: number[] = [];
  const firstPageObj = 5;
  for (let i = 0; i < pages.length; i++) pageObjIds.push(firstPageObj + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((pageLines, i) => {
    const pageId = pageObjIds[i];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = contentStream(pageLines);
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // Serializar con tabla xref
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  const maxId = objects.length - 1;
  for (let id = 1; id <= maxId; id++) {
    if (!objects[id]) continue;
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    const off = offsets[id] ?? 0;
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Latin-1: cada char del string es un byte (pdfEscape ya quitó lo demás).
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

export type { Line as PdfLine };
