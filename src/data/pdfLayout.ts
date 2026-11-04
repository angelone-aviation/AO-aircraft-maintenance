/**
 * Responsibility: Lays out document content as PDF pages, so writers decide
 *   what a document says and not how it flows.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf.
 */
import { jsPDF } from "jspdf";

const MARGIN_MM = 17;
const TOP_MM = 18;
const TEXT_WIDTH_MM = 176;
const LAST_LINE_MM = 275;
const LINE_MM = 6;
const PARAGRAPH_GAP_MM = 2;
const BOLD_FONT_PT = 12;
const BODY_FONT_PT = 10;

/** One paragraph of a text document; bold paragraphs print larger. */
export interface Paragraph {
  text: string;
  bold?: boolean;
}

/** Layout state while paragraphs are written. */
type Page = { doc: jsPDF; y: number };

/**
 * Flows paragraphs down A4 portrait pages in Helvetica, 12 pt bold or 10 pt
 * normal, wrapped to the text width with a small gap after each paragraph.
 * Lines continue on a new page once a page is full.
 * @param paragraphs - The document's text, in order.
 * @returns The document, ready for `save()`.
 */
export function paragraphPdf(paragraphs: Paragraph[]): jsPDF {
  const page: Page = { doc: new jsPDF(), y: TOP_MM };
  for (const paragraph of paragraphs) writeParagraph(page, paragraph);
  return page.doc;
}

function writeParagraph(page: Page, { text, bold }: Paragraph): void {
  const { doc } = page;
  doc.setFont("helvetica", bold ? "bold" : "normal");
  doc.setFontSize(bold ? BOLD_FONT_PT : BODY_FONT_PT);
  for (const row of doc.splitTextToSize(text, TEXT_WIDTH_MM)) {
    if (page.y > LAST_LINE_MM) {
      doc.addPage();
      page.y = TOP_MM;
    }
    doc.text(row, MARGIN_MM, page.y);
    page.y += LINE_MM;
  }
  page.y += PARAGRAPH_GAP_MM;
}
