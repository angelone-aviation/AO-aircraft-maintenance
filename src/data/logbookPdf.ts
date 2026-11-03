/**
 * Responsibility: Lays out a generated logbook entry as an A4 PDF to print and
 *   sign.
 * Layer: Data. Browser-only: fetches the bundled font; no React.
 * Dependencies: jspdf, public/fonts/DejaVuSans.ttf.
 *
 * Embeds DejaVu Sans because jsPDF's standard fonts only encode Windows-1252,
 * and an entry can hold any character.
 */
import { jsPDF } from "jspdf";

const FONT_FILE = "DejaVuSans.ttf";
const FONT_NAME = "DejaVu";

// Spreading the whole font into String.fromCharCode would exceed the engine's
// argument limit.
const CHAR_CODE_CHUNK = 8192;

const A4_WIDTH_MM = 210;
const MARGIN_MM = 18;
const TOP_MM = 20;
const LAST_LINE_MM = 275;
const LINE_HEIGHT_MM = 5;
const FOOTER_BASELINE_MM = 287;

/**
 * Renders logbook-entry text as a paginated A4 document, numbered "Page n of
 * N" at the foot of each page.
 *
 * @param text - The entry text. Carriage returns and control characters other
 *   than tab and newline are dropped; long lines wrap. jsPDF leaves out the
 *   rest of a line after a tab.
 * @returns The document, ready for `save()`.
 * @throws {Error} "Unable to load the PDF font. Reconnect and try again." when
 *   the font request fails with an HTTP error; a network failure rejects with
 *   fetch's own error.
 */
export async function logbookPdf(text: string): Promise<jsPDF> {
  const font = await fetchFontBase64();
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  pdf.addFileToVFS(FONT_FILE, font);
  pdf.addFont(FONT_FILE, FONT_NAME, "normal");
  pdf.setFont(FONT_NAME);
  pdf.setFontSize(10);
  const lines: string[] = pdf.splitTextToSize(
    stripControlCharacters(text),
    A4_WIDTH_MM - 2 * MARGIN_MM,
  );
  writeLines(pdf, lines);
  numberPages(pdf);
  return pdf;
}

async function fetchFontBase64(): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}fonts/${FONT_FILE}`);
  if (!response.ok)
    throw new Error("Unable to load the PDF font. Reconnect and try again.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHAR_CODE_CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHAR_CODE_CHUNK));
  return btoa(binary);
}

function stripControlCharacters(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function writeLines(pdf: jsPDF, lines: string[]): void {
  let y = TOP_MM;
  for (const line of lines) {
    if (y > LAST_LINE_MM) {
      pdf.addPage();
      y = TOP_MM;
    }
    pdf.text(line, MARGIN_MM, y);
    y += LINE_HEIGHT_MM;
  }
}

// Runs after layout, once the page count is known.
function numberPages(pdf: jsPDF): void {
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFontSize(8);
    pdf.text(
      `Page ${page} of ${pages}`,
      A4_WIDTH_MM - MARGIN_MM,
      FOOTER_BASELINE_MM,
      { align: "right" },
    );
  }
}
