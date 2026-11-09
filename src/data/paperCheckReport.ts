/**
 * Responsibility: Prints one aircraft's monthly paper check as a landscape
 *   PDF, or as a CSV, from the domain's rows.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/domain/reconciliation.ts (content),
 *   src/domain/csv.ts (CSV), src/domain/model.ts (types).
 *
 * A checklist for the person comparing the app with the paper logbook, not a
 * maintenance record: the footer of every page says so. The private table
 * writer below copies the status sheet's (aircraftStatusReport.ts); it
 * should move to the shared table helper once that lands beside pdfLayout.ts.
 */
import { jsPDF } from "jspdf";
import type { Snapshot } from "../domain/model";
import { toCsv } from "../domain/csv";
import {
  paperCheck,
  paperCheckRecords,
  PAPER_CHECK_FLIGHT_COLUMNS,
  PAPER_CHECK_WORK_COLUMNS,
  type PaperCheck,
} from "../domain/reconciliation";

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
const BRAND: Rgb = [28, 69, 57];
const HEADING_FILL: Rgb = [48, 91, 77];
const STRIPE: Rgb = [239, 246, 241];
const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [35, 48, 43];
const GRID: Rgb = [195, 211, 201];
// Relative column widths; each table spans WIDTH_MM. The Checked column is
// wide enough for a pen tick.
const FLIGHT_SHARES = [24, 40, 22, 22, 18, 20, 26, 26, 16, 22];
const WORK_SHARES = [24, 120, 50, 20, 24];
const FOOTER_TEXT =
  "Tick Checked against the paper logbook. Rows are as recorded in the app; the signed paper record governs.";

/** Layout state while one check is written. */
type Sheet = { pdf: jsPDF; check: PaperCheck; now: Date; y: number };
type Table = { title: string; labels: string[]; widths: number[] };

/**
 * Builds the paper check PDF for one aircraft and month: the flights table,
 * the month's totals, then the completed work orders. The built-in font
 * draws printable ASCII only: dashes print as "-" and other characters as
 * spaces. An empty table prints one "None recorded" row.
 *
 * @param state - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft.
 * @param yearMonth - The month as `YYYY-MM`.
 * @param now - When the check is generated, printed in the header.
 * @returns The document, ready for `save()`.
 * @throws {Rejection} As {@link paperCheck}: "Aircraft not found."; "Choose
 *   a month as YYYY-MM."
 */
export function paperCheckPdf(
  state: Snapshot,
  aircraftUuid: string,
  yearMonth: string,
  now = new Date(),
): jsPDF {
  const check = paperCheck(state, aircraftUuid, yearMonth);
  const pdf = new jsPDF({
    unit: "mm",
    format: "letter",
    orientation: "landscape",
  });
  const sheet: Sheet = { pdf, check, now, y: TOP_MM };
  drawPageHeader(sheet);
  const meter = check.header.meter;
  const flightLabels = PAPER_CHECK_FLIGHT_COLUMNS.map((c) =>
    c.startsWith("Meter") ? c.replace("Meter", meter) : c,
  );
  writeTable(
    sheet,
    "Flights",
    flightLabels,
    FLIGHT_SHARES,
    check.flights.map((r) => Object.values(r)),
  );
  writeNote(
    sheet,
    `Month totals (accepted flights): ${check.totals.flights} flights, ${check.totals.hours} hours, ${check.totals.landings} landings.`,
  );
  writeTable(
    sheet,
    "Maintenance sign-offs",
    [...PAPER_CHECK_WORK_COLUMNS],
    WORK_SHARES,
    check.work.map((r) => Object.values(r)),
  );
  writeFooters(sheet);
  return pdf;
}

/**
 * The paper check as a CSV file's text.
 *
 * @param state - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft.
 * @param yearMonth - The month as `YYYY-MM`.
 * @returns {@link toCsv} of {@link paperCheckRecords}: a Section column, the
 *   flight and work columns, and a closing Totals record.
 * @throws {Rejection} As {@link paperCheck}.
 */
export function paperCheckCsv(
  state: Snapshot,
  aircraftUuid: string,
  yearMonth: string,
): string {
  return toCsv(paperCheckRecords(paperCheck(state, aircraftUuid, yearMonth)));
}

/**
 * The file name a saved check takes.
 *
 * @param registration - The aircraft's registration; characters other than
 *   letters, digits and hyphens become "_".
 * @param yearMonth - The month as `YYYY-MM`.
 * @param extension - "pdf" or "csv".
 * @returns `<registration>-paper-check-<yearMonth>.<extension>`.
 */
export function paperCheckFileName(
  registration: string,
  yearMonth: string,
  extension: "pdf" | "csv",
): string {
  const safe = registration.replace(/[^a-z0-9-]/gi, "_") || "aircraft";
  return `${safe}-paper-check-${yearMonth}.${extension}`;
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function toPrintable(value: string): string {
  return value.replace(/[–—]/g, "-").replace(/[^\x20-\x7e\n]/g, " ");
}

function drawPageHeader({ pdf, check, now }: Sheet): void {
  const { header } = check;
  pdf.setFillColor(...BRAND);
  pdf.rect(0, 0, PAGE_WIDTH_MM, 20, "F");
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.text(
    toPrintable(`${header.registration} | PAPER CHECK | ${header.month}`),
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
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(BODY_FONT_PT);
  pdf.setTextColor(...INK);
  if (sheet.y + 5 > BOTTOM_MM) startPage(sheet);
  pdf.text(toPrintable(value), LEFT_MM, sheet.y + 3);
  sheet.y += 8;
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
  const shown = rows.length
    ? rows
    : [["None recorded", ...labels.slice(1).map(() => "")]];
  shown.forEach((row, index) => writeTableRow(sheet, table, row, index));
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

// A row that does not fit moves whole to a new page, under the heading
// again; the Checked cell stays empty for the pen.
function writeTableRow(
  sheet: Sheet,
  table: Table,
  row: string[],
  index: number,
): void {
  const { pdf } = sheet;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(CELL_FONT_PT);
  const cells = wrapCells(pdf, table, row);
  const height = Math.max(...cells.map((c) => c.length)) * LINE_MM + 4;
  if (sheet.y + height > BOTTOM_MM) {
    startPage(sheet);
    writeTableHeading(sheet, table);
  }
  const { y } = sheet;
  let x = LEFT_MM;
  pdf.setFillColor(...(index % 2 === 0 ? STRIPE : WHITE));
  pdf.rect(LEFT_MM, y, WIDTH_MM, height, "F");
  cells.forEach((lines, i) => {
    pdf.setTextColor(...INK);
    pdf.setFont("helvetica", i === 0 ? "bold" : "normal");
    pdf.setFontSize(CELL_FONT_PT);
    if (table.labels[i] !== "Checked")
      pdf.text(lines, x + CELL_PADDING_MM, y + 5);
    pdf.setDrawColor(...GRID);
    pdf.setLineWidth(0.15);
    pdf.rect(x, y, table.widths[i], height);
    x += table.widths[i];
  });
  sheet.y += height;
}

function writeFooters({ pdf, check }: Sheet): void {
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(BODY_FONT_PT);
    pdf.setTextColor(75);
    pdf.text(FOOTER_TEXT, LEFT_MM, FOOTER_MM);
    pdf.text(
      `${check.header.registration} | Page ${page} of ${pages}`,
      RIGHT_MM,
      FOOTER_MM,
      { align: "right" },
    );
  }
}
