/**
 * Responsibility: Prints one aircraft's status sheet as a landscape PDF.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/domain/statusSheet.ts (content),
 *   src/domain/model.ts (localDate).
 *
 * A summary of recorded status for the 14 CFR 91.417(a)(2) records, not a
 * maintenance release: the footer of every page says so.
 */
import { jsPDF } from "jspdf";
import { localDate, type Snapshot } from "../domain/model";
import {
  statusSheet,
  type StatusSectionId,
  type StatusSheet,
} from "../domain/statusSheet";

type Rgb = [number, number, number];

const PAGE_WIDTH_MM = 279.4;
const LEFT_MM = 10;
const WIDTH_MM = 259;
const RIGHT_MM = 269;
const TOP_MM = 26;
const BOTTOM_MM = 194;
const FOOTER_MM = 204;
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
// Relative column widths per section; each table spans WIDTH_MM.
const COLUMN_SHARES: Record<StatusSectionId, number[]> = {
  overview: [34, 32, 42, 32, 38, 60],
  components: [45, 65, 39, 28, 28, 28, 26],
  inspections: [46, 27, 29, 25, 24, 23, 22, 22, 28],
  airworthiness: [31, 45, 80, 63, 40],
  form337: [170, 50, 39],
  discrepancies: [30, 200, 29],
};

/** Layout state while one sheet is written. */
type Sheet = {
  pdf: jsPDF;
  header: StatusSheet["header"];
  now: Date;
  y: number;
};
type Table = { title: string; labels: string[]; widths: number[] };

/**
 * Builds the status sheet for one aircraft, as recorded in the snapshot.
 * Cells reading "overdue" or a negative number print red and bold; "Needs
 * review" and "due-soon" amber. The built-in font draws printable ASCII
 * only: dashes print as "-" and other characters as spaces.
 *
 * @param state - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft to report on.
 * @param now - When the sheet is generated; it sets "today" for due dates.
 * @returns The document, ready for `save()`.
 * @throws {Rejection} "Aircraft not found." when the snapshot lacks the
 *   aircraft.
 */
export function aircraftStatusReport(
  state: Snapshot,
  aircraftUuid: string,
  now = new Date(),
) {
  const content = statusSheet(state, aircraftUuid, localDate(now.getTime()));
  const pdf = new jsPDF({
    unit: "mm",
    format: "letter",
    orientation: "landscape",
  });
  const sheet: Sheet = { pdf, header: content.header, now, y: TOP_MM };
  drawPageHeader(sheet);
  for (const section of content.sections) {
    const shares = COLUMN_SHARES[section.id];
    writeTable(sheet, section.title, section.columns, shares, section.rows);
    for (const note of section.notes) writeNote(sheet, note);
  }
  writeFooters(sheet);
  return pdf;
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function toPrintable(value: string): string {
  return value.replace(/[–—]/g, "-").replace(/[^\x20-\x7e\n]/g, " ");
}

function drawPageHeader({ pdf, header, now }: Sheet): void {
  pdf.setFillColor(...BRAND);
  pdf.rect(0, 0, PAGE_WIDTH_MM, 20, "F");
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.text(
    toPrintable(`${header.registration} | AIRCRAFT STATUS SHEET`),
    LEFT_MM,
    10,
  );
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(BODY_FONT_PT);
  pdf.text(
    toPrintable(`${header.makeModel} | S/N ${header.serial}`),
    LEFT_MM,
    16,
  );
  pdf.text(`Generated ${formatUtc(now)} UTC`, RIGHT_MM, 10, { align: "right" });
}

function startPage(sheet: Sheet): void {
  sheet.pdf.addPage();
  drawPageHeader(sheet);
  sheet.y = TOP_MM;
}

function writeNote(sheet: Sheet, value: string): void {
  const { pdf } = sheet;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(BODY_FONT_PT);
  pdf.setTextColor(60);
  const lines: string[] = pdf.splitTextToSize(toPrintable(value), WIDTH_MM);
  for (const text of lines) {
    if (sheet.y + 5 > BOTTOM_MM) startPage(sheet);
    pdf.setTextColor(60);
    pdf.setFontSize(BODY_FONT_PT);
    pdf.text(text, LEFT_MM, sheet.y + 3);
    sheet.y += 4;
  }
  sheet.y += 2;
}

function writeTable(
  sheet: Sheet,
  title: string,
  labels: string[],
  shares: number[],
  rows: string[][],
): void {
  const sum = shares.reduce((x, z) => x + z, 0);
  const table = {
    title,
    labels,
    widths: shares.map((x) => (x / sum) * WIDTH_MM),
  };
  if (sheet.y + TABLE_START_SPACE_MM > BOTTOM_MM) startPage(sheet);
  writeTableHeading(sheet, table);
  rows.forEach((row, index) => writeTableRow(sheet, table, row, index));
  sheet.y += 6;
}

function wrapCells(pdf: jsPDF, table: Table, cells: string[]): string[][] {
  return cells.map(
    (text, index) =>
      pdf.splitTextToSize(
        toPrintable(text || "-"),
        table.widths[index] - 2 * CELL_PADDING_MM,
      ) as string[],
  );
}

function writeTableHeading(sheet: Sheet, table: Table): void {
  const { pdf } = sheet;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(...BRAND);
  pdf.text(table.title.toUpperCase(), LEFT_MM, sheet.y + 4);
  sheet.y += 7;
  pdf.setFontSize(BODY_FONT_PT);
  const cells = wrapCells(pdf, table, table.labels);
  const height = Math.max(...cells.map((c) => c.length)) * LINE_MM + 4;
  let x = LEFT_MM;
  pdf.setFillColor(...HEADING_FILL);
  pdf.rect(LEFT_MM, sheet.y, WIDTH_MM, height, "F");
  cells.forEach((lines, i) => {
    pdf.setTextColor(255);
    pdf.text(lines, x + CELL_PADDING_MM, sheet.y + 5);
    x += table.widths[i];
  });
  sheet.y += height;
}

// A row continued on a new page repeats the table heading above it.
function writeTableRow(
  sheet: Sheet,
  table: Table,
  row: string[],
  index: number,
): void {
  sheet.pdf.setFont("helvetica", "normal");
  sheet.pdf.setFontSize(CELL_FONT_PT);
  const cells = wrapCells(sheet.pdf, table, row);
  const count = Math.max(...cells.map((c) => c.length));
  const rowHeight = count * LINE_MM + 4;
  if (rowHeight <= SPLIT_ROW_MM && sheet.y + rowHeight > BOTTOM_MM)
    startTablePage(sheet, table);
  for (let offset = 0; offset < count;) {
    if (sheet.y + 8 > BOTTOM_MM) startTablePage(sheet, table);
    const take = Math.min(
      count - offset,
      Math.max(1, Math.floor((BOTTOM_MM - sheet.y - 4) / LINE_MM)),
    );
    drawRowSlice(sheet, table, row, index, cells, offset, take);
    offset += take;
  }
}

function startTablePage(sheet: Sheet, table: Table): void {
  startPage(sheet);
  writeTableHeading(sheet, table);
}

function drawRowSlice(
  sheet: Sheet,
  table: Table,
  row: string[],
  index: number,
  cells: string[][],
  offset: number,
  take: number,
): void {
  const { pdf, y } = sheet;
  const height = take * LINE_MM + 4;
  let x = LEFT_MM;
  pdf.setFillColor(...(index % 2 === 0 ? STRIPE : WHITE));
  pdf.rect(LEFT_MM, y, WIDTH_MM, height, "F");
  cells.forEach((lines, i) => {
    const value = row[i] || "";
    const danger = /overdue|^-/i.test(value) && value !== "-";
    pdf.setTextColor(...(danger ? DANGER : cellInk(value)));
    pdf.setFont("helvetica", i === 0 || danger ? "bold" : "normal");
    pdf.setFontSize(CELL_FONT_PT);
    pdf.text(lines.slice(offset, offset + take), x + CELL_PADDING_MM, y + 5);
    pdf.setDrawColor(...GRID);
    pdf.setLineWidth(0.15);
    pdf.rect(x, y, table.widths[i], height);
    x += table.widths[i];
  });
  sheet.y += height;
}

function cellInk(value: string): Rgb {
  return /Needs review|due-soon/i.test(value) ? CAUTION : INK;
}

function writeFooters({ pdf, header }: Sheet): void {
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(BODY_FONT_PT);
    pdf.setTextColor(75);
    pdf.text(
      "Recorded status only. Consult aircraft records for actual sign-offs; not a maintenance release.",
      LEFT_MM,
      FOOTER_MM,
    );
    pdf.text(
      `${header.registration} | Page ${page} of ${pages}`,
      RIGHT_MM,
      FOOTER_MM,
      {
        align: "right",
      },
    );
  }
}
