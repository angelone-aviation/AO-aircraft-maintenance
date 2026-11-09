/**
 * Responsibility: Lays out titled tables and their notes as letter-size PDF
 *   pages with a brand header and numbered footers.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf.
 *
 * Shared by the status sheet and the records package so both print alike.
 * The built-in Helvetica encodes printable ASCII only; a caller that needs
 * Unicode passes an embedded font.
 */
import { jsPDF } from "jspdf";

type Rgb = [number, number, number];

/** A page's orientation; a letter page is 215.9 by 279.4 mm. */
export type PageOrientation = "portrait" | "landscape";

/** One table of a document and the notes printed under it. */
export interface PdfTable {
  title: string;
  columns: string[];
  /** One cell per column; a cell may hold newlines. */
  rows: string[][];
  notes: string[];
  /** Relative column widths; equal widths when left out. */
  shares?: number[];
  /** The table starts on a page of this orientation; the document's if unset. */
  orientation?: PageOrientation;
}

/** A TrueType font to embed, already base64-encoded, with one style only. */
export interface EmbeddedFont {
  file: string;
  name: string;
  base64: string;
}

/** What every page shows besides the tables. */
export interface TablePdfOptions {
  /** The orientation of pages whose table does not ask for another. */
  orientation: PageOrientation;
  /** The brand band: a bold title, a subtitle, and text at the right. */
  header: { title: string; subtitle: string; right: string };
  /** The note at the left of each footer, and the label before "Page n of N". */
  footer: { note: string; label: string };
  /** Replaces Helvetica, so any character prints. Headings are not bold. */
  font?: EmbeddedFont;
}

const LETTER_SHORT_MM = 215.9;
const LETTER_LONG_MM = 279.4;
const LEFT_MM = 10;
const RIGHT_MARGIN_MM = 10.4;
const TOP_MM = 26;
const BOTTOM_MARGIN_MM = 21.9;
const FOOTER_MARGIN_MM = 11.9;
const HEADER_BAND_MM = 20;
// The space character; everything below it is a control character.
const FIRST_PRINTABLE_CODE = 0x20;
const LINE_MM = 3.8;
const CELL_PADDING_MM = 2;
const BODY_FONT_PT = 8;
const CELL_FONT_PT = 8.5;
// Start a table on a fresh page unless its heading and a few rows fit.
const TABLE_START_SPACE_MM = 35;
// Keep ordinary rows together; only rows taller than this are split.
const SPLIT_ROW_MM = 140;
const BRAND: Rgb = [28, 69, 57];
const HEADING_FILL: Rgb = [48, 91, 77];
const STRIPE: Rgb = [239, 246, 241];
const WHITE: Rgb = [255, 255, 255];
const DANGER: Rgb = [165, 35, 35];
const CAUTION: Rgb = [134, 83, 0];
const INK: Rgb = [35, 48, 43];
const GRID: Rgb = [195, 211, 201];

/** Where text may go on a page of one orientation. */
type Geometry = {
  pageWidth: number;
  textWidth: number;
  right: number;
  bottom: number;
  footer: number;
};

/** The font in use and how a cell's text is made printable in it. */
type Face = {
  name: string;
  boldStyle: "bold" | "normal";
  printable: (value: string) => string;
};

/** Layout state while one document is written. */
type Layout = {
  pdf: jsPDF;
  face: Face;
  options: TablePdfOptions;
  orientation: PageOrientation;
  page: Geometry;
  y: number;
};

type Table = { title: string; labels: string[]; widths: number[] };

/**
 * Writes tables as a letter-size document: each table's title, a filled
 * heading row, striped rows, then its notes, flowing across pages. A table
 * whose orientation differs from the current page starts a new page, and the
 * first page takes the first table's orientation. A row continued on a new
 * page repeats the table heading. Cells reading "overdue" or a negative
 * number print red and bold; "Needs review" and "due-soon" amber; the first
 * column bold. With Helvetica, dashes print as "-" and other non-ASCII
 * characters as spaces.
 *
 * @param tables - The tables in reading order.
 * @param options - The orientation, header, footer and optional font.
 * @returns The document, ready for `save()` or `output()`.
 */
export function tablePdf(tables: PdfTable[], options: TablePdfOptions): jsPDF {
  const orientation = tables[0]?.orientation ?? options.orientation;
  const pdf = new jsPDF({ unit: "mm", format: "letter", orientation });
  const layout: Layout = {
    pdf,
    face: installFont(pdf, options.font),
    options,
    orientation,
    page: geometry(orientation),
    y: TOP_MM,
  };
  drawPageHeader(layout);
  for (const table of tables) {
    const wanted = table.orientation ?? options.orientation;
    if (wanted !== layout.orientation) startPage(layout, wanted);
    writeTable(layout, table);
    for (const note of table.notes) writeNote(layout, note);
  }
  writeFooters(layout);
  return pdf;
}

function installFont(pdf: jsPDF, font: EmbeddedFont | undefined): Face {
  if (!font)
    return { name: "helvetica", boldStyle: "bold", printable: toPrintable };
  pdf.addFileToVFS(font.file, font.base64);
  pdf.addFont(font.file, font.name, "normal");
  // jsPDF falls back to Times for a style the font lacks.
  return { name: font.name, boldStyle: "normal", printable: stripControls };
}

function geometry(orientation: PageOrientation): Geometry {
  const landscape = orientation === "landscape";
  const pageWidth = landscape ? LETTER_LONG_MM : LETTER_SHORT_MM;
  const pageHeight = landscape ? LETTER_SHORT_MM : LETTER_LONG_MM;
  return {
    pageWidth,
    textWidth: roundMm(pageWidth - LEFT_MM - RIGHT_MARGIN_MM),
    right: roundMm(pageWidth - RIGHT_MARGIN_MM),
    bottom: roundMm(pageHeight - BOTTOM_MARGIN_MM),
    footer: roundMm(pageHeight - FOOTER_MARGIN_MM),
  };
}

// Page edges are whole tenths of a millimetre; the subtraction is not.
function roundMm(value: number): number {
  return Math.round(value * 10) / 10;
}

function toPrintable(value: string): string {
  return value.replace(/[–—]/g, "-").replace(/[^\x20-\x7e\n]/g, " ");
}

// jsPDF leaves out the rest of a line after a tab, and draws nothing useful
// for other control characters; only newlines keep their meaning.
function stripControls(value: string): string {
  return Array.from(value.replace(/\t/g, " "))
    .filter((ch) => ch === "\n" || ch.charCodeAt(0) >= FIRST_PRINTABLE_CODE)
    .join("");
}

function setFont(layout: Layout, bold: boolean): void {
  const { face } = layout;
  layout.pdf.setFont(face.name, bold ? face.boldStyle : "normal");
}

function drawPageHeader(layout: Layout): void {
  const { pdf, page, face } = layout;
  const { header } = layout.options;
  pdf.setFillColor(...BRAND);
  pdf.rect(0, 0, page.pageWidth, HEADER_BAND_MM, "F");
  pdf.setTextColor(255);
  setFont(layout, true);
  pdf.setFontSize(15);
  pdf.text(face.printable(header.title), LEFT_MM, 10);
  setFont(layout, false);
  pdf.setFontSize(BODY_FONT_PT);
  pdf.text(face.printable(header.subtitle), LEFT_MM, 16);
  pdf.text(face.printable(header.right), page.right, 10, { align: "right" });
}

function startPage(layout: Layout, orientation = layout.orientation): void {
  layout.pdf.addPage("letter", orientation);
  layout.orientation = orientation;
  layout.page = geometry(orientation);
  drawPageHeader(layout);
  layout.y = TOP_MM;
}

function writeNote(layout: Layout, value: string): void {
  const { pdf, face } = layout;
  setFont(layout, false);
  pdf.setFontSize(BODY_FONT_PT);
  pdf.setTextColor(60);
  const lines: string[] = pdf.splitTextToSize(
    face.printable(value),
    layout.page.textWidth,
  );
  for (const text of lines) {
    if (layout.y + 5 > layout.page.bottom) startPage(layout);
    pdf.setTextColor(60);
    pdf.setFontSize(BODY_FONT_PT);
    pdf.text(text, LEFT_MM, layout.y + 3);
    layout.y += 4;
  }
  layout.y += 2;
}

function writeTable(layout: Layout, source: PdfTable): void {
  const shares = source.shares ?? source.columns.map(() => 1);
  const sum = shares.reduce((x, z) => x + z, 0);
  const table: Table = {
    title: source.title,
    labels: source.columns,
    widths: shares.map((x) => (x / sum) * layout.page.textWidth),
  };
  if (layout.y + TABLE_START_SPACE_MM > layout.page.bottom) startPage(layout);
  writeTableHeading(layout, table);
  source.rows.forEach((row, index) => writeTableRow(layout, table, row, index));
  layout.y += 6;
}

function wrapCells(layout: Layout, table: Table, cells: string[]): string[][] {
  return cells.map(
    (text, index) =>
      layout.pdf.splitTextToSize(
        layout.face.printable(text || "-"),
        table.widths[index] - 2 * CELL_PADDING_MM,
      ) as string[],
  );
}

function writeTableHeading(layout: Layout, table: Table): void {
  const { pdf, page } = layout;
  setFont(layout, true);
  pdf.setFontSize(10);
  pdf.setTextColor(...BRAND);
  pdf.text(
    layout.face.printable(table.title.toUpperCase()),
    LEFT_MM,
    layout.y + 4,
  );
  layout.y += 7;
  pdf.setFontSize(BODY_FONT_PT);
  const cells = wrapCells(layout, table, table.labels);
  const height = Math.max(...cells.map((c) => c.length)) * LINE_MM + 4;
  let x = LEFT_MM;
  pdf.setFillColor(...HEADING_FILL);
  pdf.rect(LEFT_MM, layout.y, page.textWidth, height, "F");
  cells.forEach((lines, i) => {
    pdf.setTextColor(255);
    pdf.text(lines, x + CELL_PADDING_MM, layout.y + 5);
    x += table.widths[i];
  });
  layout.y += height;
}

function writeTableRow(
  layout: Layout,
  table: Table,
  row: string[],
  index: number,
): void {
  setFont(layout, false);
  layout.pdf.setFontSize(CELL_FONT_PT);
  const cells = wrapCells(layout, table, row);
  const count = Math.max(...cells.map((c) => c.length));
  const rowHeight = count * LINE_MM + 4;
  const { bottom } = layout.page;
  if (rowHeight <= SPLIT_ROW_MM && layout.y + rowHeight > bottom)
    startTablePage(layout, table);
  for (let offset = 0; offset < count;) {
    if (layout.y + 8 > layout.page.bottom) startTablePage(layout, table);
    const take = Math.min(
      count - offset,
      Math.max(1, Math.floor((layout.page.bottom - layout.y - 4) / LINE_MM)),
    );
    drawRowSlice(layout, table, row, index, cells, offset, take);
    offset += take;
  }
}

function startTablePage(layout: Layout, table: Table): void {
  startPage(layout);
  writeTableHeading(layout, table);
}

function drawRowSlice(
  layout: Layout,
  table: Table,
  row: string[],
  index: number,
  cells: string[][],
  offset: number,
  take: number,
): void {
  const { pdf, y, page } = layout;
  const height = take * LINE_MM + 4;
  let x = LEFT_MM;
  pdf.setFillColor(...(index % 2 === 0 ? STRIPE : WHITE));
  pdf.rect(LEFT_MM, y, page.textWidth, height, "F");
  cells.forEach((lines, i) => {
    const value = row[i] || "";
    const danger = /overdue|^-/i.test(value) && value !== "-";
    pdf.setTextColor(...(danger ? DANGER : cellInk(value)));
    setFont(layout, i === 0 || danger);
    pdf.setFontSize(CELL_FONT_PT);
    pdf.text(lines.slice(offset, offset + take), x + CELL_PADDING_MM, y + 5);
    pdf.setDrawColor(...GRID);
    pdf.setLineWidth(0.15);
    pdf.rect(x, y, table.widths[i], height);
    x += table.widths[i];
  });
  layout.y += height;
}

function cellInk(value: string): Rgb {
  return /Needs review|due-soon/i.test(value) ? CAUTION : INK;
}

// Runs after layout, once the page count is known; each page keeps its own
// orientation, so the footer's place is read from the page.
function writeFooters(layout: Layout): void {
  const { pdf, face } = layout;
  const { footer } = layout.options;
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    const size = pdf.internal.pageSize;
    const y = roundMm(size.getHeight() - FOOTER_MARGIN_MM);
    const right = roundMm(size.getWidth() - RIGHT_MARGIN_MM);
    setFont(layout, false);
    pdf.setFontSize(BODY_FONT_PT);
    pdf.setTextColor(75);
    pdf.text(face.printable(footer.note), LEFT_MM, y);
    pdf.text(
      face.printable(`${footer.label} | Page ${page} of ${pages}`),
      right,
      y,
      { align: "right" },
    );
  }
}
