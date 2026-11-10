/**
 * Responsibility: Lays out document content as PDF pages, so writers decide
 *   what a document says and not how it flows.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/data/tablePdf.ts (EmbeddedFont type).
 *
 * jsPDF's standard fonts encode Windows-1252 only and silently print another
 * character for anything else, so every document embeds a Unicode font.
 */
import { jsPDF } from "jspdf";
import type { EmbeddedFont } from "./tablePdf";

const MARGIN_MM = 17;
const TOP_MM = 18;
const TEXT_WIDTH_MM = 176;
const LAST_LINE_MM = 275;
const LINE_MM = 6;
const PARAGRAPH_GAP_MM = 2;
const BOLD_FONT_PT = 12;
const BODY_FONT_PT = 10;
// The space character; everything below it is a control character.
const FIRST_PRINTABLE_CODE = 0x20;

/** One paragraph of a text document; bold paragraphs print larger. */
export interface Paragraph {
  text: string;
  bold?: boolean;
}

/** Layout state while paragraphs are written. */
type Page = { doc: jsPDF; y: number };

/**
 * Flows paragraphs down A4 portrait pages in the embedded font, 12 pt for
 * bold paragraphs and 10 pt for others (the font has one style), wrapped to
 * the text width with a small gap after each paragraph. Lines continue on a
 * new page once a page is full. Tabs print as spaces; other control
 * characters except newlines are dropped. A character the font lacks prints
 * as an empty box.
 *
 * @param paragraphs - The document's text, in order.
 * @param font - The Unicode font to embed, from `loadDejaVuFont()`.
 * @returns The document, ready for `save()`.
 */
export function paragraphPdf(
  paragraphs: Paragraph[],
  font: EmbeddedFont,
): jsPDF {
  const doc = new jsPDF();
  doc.addFileToVFS(font.file, font.base64);
  doc.addFont(font.file, font.name, "normal");
  doc.setFont(font.name, "normal");
  const page: Page = { doc, y: TOP_MM };
  for (const paragraph of paragraphs) writeParagraph(page, paragraph);
  return page.doc;
}

function writeParagraph(page: Page, { text, bold }: Paragraph): void {
  const { doc } = page;
  doc.setFontSize(bold ? BOLD_FONT_PT : BODY_FONT_PT);
  for (const row of doc.splitTextToSize(stripControls(text), TEXT_WIDTH_MM)) {
    if (page.y > LAST_LINE_MM) {
      doc.addPage();
      page.y = TOP_MM;
    }
    doc.text(row, MARGIN_MM, page.y);
    page.y += LINE_MM;
  }
  page.y += PARAGRAPH_GAP_MM;
}

// jsPDF leaves out the rest of a line after a tab, and draws nothing useful
// for other control characters; only newlines keep their meaning.
function stripControls(value: string): string {
  return Array.from(value.replace(/\t/g, " "))
    .filter((ch) => ch === "\n" || ch.charCodeAt(0) >= FIRST_PRINTABLE_CODE)
    .join("");
}
