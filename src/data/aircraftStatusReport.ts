/**
 * Responsibility: Prints one aircraft's status sheet as a landscape PDF:
 *   totals, installed components, inspections, ADs, Form 337 copies and open
 *   discrepancies.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/domain (model, maintenance, management,
 *   components, componentCalendar, airworthiness, adRemaining, aircraftFiles).
 *
 * A summary of recorded status for the 14 CFR 91.417(a)(2) records, not a
 * maintenance release: the footer of every page says so.
 */
import { jsPDF } from "jspdf";
import {
  localDate,
  totalSeconds,
  aircraftMeterLabels,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "../domain/model";
import { inspectionDueDate, inspectionStatus } from "../domain/maintenance";
import { inspectionCounters } from "../domain/management";
import { componentTotals, type Component } from "../domain/components";
import { daysPerServiceMonth } from "../domain/componentCalendar";
import { adAircraftUuid, adStatus, type AD } from "../domain/airworthiness";
import { adRemaining } from "../domain/adRemaining";
import { isCurrentAircraftFile } from "../domain/aircraftFiles";

type Rgb = [number, number, number];
type Records = NonNullable<Snapshot["management"]>;

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

/** Layout state while one sheet is written. */
type Sheet = { pdf: jsPDF; aircraft: Aircraft; now: Date; y: number };
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
 * @throws {Error} "Aircraft not found." when the snapshot lacks the aircraft.
 */
export function aircraftStatusReport(
  state: Snapshot,
  aircraftUuid: string,
  now = new Date(),
) {
  const a = state.aircraft.find((x) => x.uuid === aircraftUuid);
  if (!a) throw Error("Aircraft not found.");
  const today = localDate(now.getTime());
  const pdf = new jsPDF({
    unit: "mm",
    format: "letter",
    orientation: "landscape",
  });
  const sheet: Sheet = { pdf, aircraft: a, now, y: TOP_MM };
  drawPageHeader(sheet);
  writeOverview(sheet, state);
  const components = (state.management ?? []).filter(
    (c) => c.kind === "component" && c.installed && c.aircraftUuid === a.uuid,
  );
  writeComponents(sheet, components, today);
  writeInspections(sheet, state, components, today);
  writeADs(sheet, state, components, today);
  writeForm337s(sheet, state);
  writeDiscrepancies(sheet, state);
  writeFooters(sheet);
  return pdf;
}

function writeOverview(sheet: Sheet, state: Snapshot): void {
  const a = sheet.aircraft;
  writeTable(
    sheet,
    "Aircraft overview",
    [
      "Recorded aircraft status:",
      "Aircraft total time:",
      "Hobbs / Tach (hours)",
      "Cycles / Landings",
      "Tracking meter",
      "Flight program",
    ],
    [34, 32, 42, 32, 38, 60],
    [
      [
        a.operationalStatus,
        `${formatHours(totalSeconds(a))} hours`,
        `${formatHours(a.currentHobbs)} / ${formatHours(a.currentTach)}`,
        `${a.cycles} / ${a.landings}`,
        aircraftMeterLabels[a.meter],
        a.program,
      ],
    ],
  );
  if (a.flightTimeLog && a.currentFlightTimeLog !== undefined)
    writeNote(
      sheet,
      `Flight time log: ${formatHours(a.currentFlightTimeLog)} hours`,
    );
  if (a.currentCyclicHobbs !== undefined)
    writeNote(
      sheet,
      `Collective hourmeter: ${formatHours(a.currentCyclicHobbs)} hours`,
    );
  writeNote(
    sheet,
    `Data synchronized ${formatUtc(new Date(state.syncedAt))} UTC. Negative remaining values are overdue; months are approximate. Calendar exempt suppresses calendar only.`,
  );
}

function writeComponents(
  sheet: Sheet,
  components: Records,
  today: string,
): void {
  writeTable(
    sheet,
    "Installed components",
    [
      "Position / component",
      "Part number / model",
      "Serial number",
      "TSN hours",
      "TSO hours",
      "TSR hours",
      "Cycles",
    ],
    [45, 65, 39, 28, 28, 28, 26],
    components.length
      ? components.map((c) => {
          if (c.kind !== "component") throw Error("Invalid component");
          return componentRow(c, sheet.aircraft, today);
        })
      : [["No installed component records", "-", "-", "-", "-", "-", "-"]],
  );
}

function componentRow(c: Component, a: Aircraft, today: string): string[] {
  const identity = [
    `${c.installPosition || ""} ${c.componentType}`,
    c.partNumber,
    c.serial,
  ];
  let totals: ReturnType<typeof componentTotals>;
  try {
    totals = componentTotals(c, a, today);
  } catch {
    // Usage that cannot be computed (readings before the installation
    // baseline) is flagged for review rather than stopping the sheet.
    return [...identity, "Review", "Review", "Review", "Review"];
  }
  const times = c.trackTime
    ? [
        formatHours(totals.timeSinceNew),
        formatHours(totals.timeSinceOverhaul),
        formatHours(totals.timeSinceRepair),
      ]
    : ["Not tracked", "Not tracked", "Not tracked"];
  const cycles = c.trackCycles ? String(totals.cyclesSinceNew) : "Not tracked";
  return [...identity, ...times, cycles];
}

function writeInspections(
  sheet: Sheet,
  state: Snapshot,
  components: Records,
  today: string,
): void {
  const a = sheet.aircraft;
  const inspections = state.inspections
    .filter((i) => !i.archived && i.aircraftUuid === a.uuid)
    .sort((x, z) =>
      x.reference.localeCompare(z.reference, undefined, { numeric: true }),
    );
  writeTable(
    sheet,
    "Inspection schedules",
    [
      "Inspection / component",
      "Repeat interval",
      "Last completed",
      "Next due\nHours / cycles / landings",
      "Date due",
      "Hours remaining",
      "Months remaining*",
      "Cycles / landings remaining",
      "Status",
    ],
    [46, 27, 29, 25, 24, 23, 22, 22, 28],
    inspections.length
      ? inspections.map((i) => inspectionRow(i, state, components, a, today))
      : [["No active inspection schedules", ...Array(8).fill("-")]],
  );
  writeExemptionNotes(sheet, inspections);
  writeNote(
    sheet,
    "* Months remaining are approximate; the exact date due controls. Hours and cycles use each inspection's configured counter; landings use aircraft total landings.",
  );
}

function inspectionRow(
  i: Inspection,
  state: Snapshot,
  components: Records,
  a: Aircraft,
  today: string,
): string[] {
  const r = inspectionStatus(
    i,
    a,
    today,
    inspectionCounters(i, a, state.management),
  );
  const component = components.find((c) => c.uuid === i.componentUuid);
  const asset =
    component?.kind === "component"
      ? `\n${component.installPosition || ""} S/N ${component.serial}`
      : "";
  const months =
    r.daysRemaining === undefined
      ? undefined
      : r.daysRemaining / daysPerServiceMonth;
  return [
    (i.reference || i.description) + asset,
    joinLines(listInterval(i)) || "One-time",
    joinLines(listLastDone(i)) || "-",
    joinLines(listNextDue(i)) || "-",
    i.calendarExempt ? "Calendar exempt" : inspectionDueDate(i) || "-",
    formatNumber(r.hoursRemaining),
    formatNumber(months),
    joinLines(listCountsRemaining(r)) || "-",
    r.status,
  ];
}

function listCountsRemaining(r: ReturnType<typeof inspectionStatus>) {
  return [
    r.cyclesRemaining === undefined
      ? ""
      : `${formatNumber(r.cyclesRemaining, 0)} cyc`,
    r.landingsRemaining === undefined
      ? ""
      : `${formatNumber(r.landingsRemaining, 0)} landings`,
  ];
}

function listInterval(i: Inspection): (string | null | undefined)[] {
  const exempt = i.calendarExempt ? " (exempt)" : "";
  return [
    i.intervalSeconds ? `${formatHours(i.intervalSeconds)} h` : null,
    i.intervalCycles ? `${i.intervalCycles} cyc` : null,
    i.intervalLandings ? `${i.intervalLandings} landings` : null,
    i.intervalMonths ? `${i.intervalMonths} mo${exempt}` : null,
  ];
}

function listLastDone(i: Inspection): (string | null | undefined)[] {
  return [
    i.lastSeconds !== undefined ? `${formatHours(i.lastSeconds)} h` : null,
    i.lastCycles !== undefined ? `${i.lastCycles} cyc` : null,
    i.lastLandings !== undefined ? `${i.lastLandings} landings` : null,
    i.lastDate,
  ];
}

function listNextDue(i: Inspection): (string | null | undefined)[] {
  return [
    i.dueSeconds !== undefined ? `${formatHours(i.dueSeconds)} h` : null,
    i.dueCycles !== undefined ? `${i.dueCycles} cyc` : null,
    i.dueLandings !== undefined ? `${i.dueLandings} landings` : null,
  ];
}

function writeExemptionNotes(sheet: Sheet, inspections: Inspection[]): void {
  const reasons = new Map<string, string[]>();
  for (const i of inspections.filter((i) => i.calendarExempt)) {
    const reason = i.calendarExemptReason || "Reason not recorded";
    reasons.set(reason, [...(reasons.get(reason) || []), i.reference]);
  }
  for (const [reason, refs] of reasons)
    writeNote(sheet, `Calendar exemption - ${refs.join(", ")}: ${reason}`);
}

function writeADs(
  sheet: Sheet,
  state: Snapshot,
  components: Records,
  today: string,
): void {
  const ads = (state.airworthiness ?? [])
    .filter((r) => adAircraftUuid(state, r) === sheet.aircraft.uuid)
    .sort(
      (x, z) =>
        x.componentUuid.localeCompare(z.componentUuid) ||
        x.source.number.localeCompare(z.source.number, undefined, {
          numeric: true,
        }),
    );
  writeTable(
    sheet,
    "Airworthiness directives",
    [
      "AD number",
      "Aircraft / component",
      "Subject / required action",
      "Remaining / prior compliance",
      "Status",
    ],
    [31, 45, 80, 63, 40],
    ads.length
      ? ads.map((r) => adRow(r, state, components, today))
      : [["No AD records", "-", "-", "-", "-"]],
  );
}

function adRow(
  r: AD,
  state: Snapshot,
  components: Records,
  today: string,
): string[] {
  const component = components.find((c) => c.uuid === r.componentUuid);
  const asset =
    component?.kind === "component"
      ? `${component.installPosition || ""} ${component.componentType}\nS/N ${component.serial}`
      : r.source.section;
  const units = r.tasks.flatMap((t) =>
    adRemaining(state, r, t, today).map((x) => `${x.label}: ${x.value}`),
  );
  if (r.priorCompliance)
    units.push(
      `PCW ${r.priorCompliance.date}`,
      formatPriorHours(r.priorCompliance),
    );
  return [
    r.source.number,
    asset,
    [r.source.subject, ...r.tasks.map((t) => t.description)].join("\n"),
    units.join("\n") || "-",
    adStatus(state, r),
  ];
}

function formatPriorHours(prior: NonNullable<AD["priorCompliance"]>): string {
  if (prior.componentHours !== null)
    return `Engine/component ${prior.componentHours.toFixed(1)} h`;
  if (prior.aircraftHours !== null)
    return `Aircraft ${prior.aircraftHours.toFixed(1)} h`;
  return "";
}

// Status record under 14 CFR 91.417(a)(2)(vi): current copies are listed;
// archived ones are counted, since they are kept but hidden.
function writeForm337s(sheet: Sheet, state: Snapshot): void {
  const all337 = (state.aircraftFiles ?? []).filter(
    (f) => f.aircraftUuid === sheet.aircraft.uuid && f.category === "form-337",
  );
  const form337 = all337
    .filter(isCurrentAircraftFile)
    .sort((x, z) => x.uploadedAt - z.uploadedAt);
  const archived = all337.length - form337.length;
  writeTable(
    sheet,
    "Form 337 copies",
    ["Document", "Uploaded", "Size"],
    [170, 50, 39],
    form337.length
      ? form337.map((f) => [
          f.name,
          localDate(f.uploadedAt),
          `${Math.ceil(f.size / 1024)} KB`,
        ])
      : [["No Form 337 copies on file", "-", "-"]],
  );
  if (archived)
    writeNote(
      sheet,
      `${archived} archived Form 337 ${archived === 1 ? "copy is" : "copies are"} not listed. Archived copies are kept in Angel One (View aircraft > Form 337 copies > Show archived).`,
    );
}

function writeDiscrepancies(sheet: Sheet, state: Snapshot): void {
  const discrepancies = state.discrepancies.filter(
    (d) => d.aircraftUuid === sheet.aircraft.uuid && d.status === "open",
  );
  writeTable(
    sheet,
    "Open discrepancies",
    ["Reported", "Description", "Status"],
    [30, 200, 29],
    discrepancies.length
      ? discrepancies.map((d) => [
          localDate(d.createdAt),
          d.description,
          "Open",
        ])
      : [["-", "No open discrepancies recorded", "-"]],
  );
}

function formatHours(seconds: number | null | undefined): string {
  return seconds == null ? "-" : (seconds / 3600).toFixed(1);
}

function formatNumber(v: number | undefined, digits = 1): string {
  return v === undefined ? "-" : v.toFixed(digits);
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function joinLines(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join("\n");
}

function toPrintable(value: string): string {
  return value.replace(/[–—]/g, "-").replace(/[^\x20-\x7e\n]/g, " ");
}

function drawPageHeader({ pdf, aircraft: a, now }: Sheet): void {
  pdf.setFillColor(...BRAND);
  pdf.rect(0, 0, PAGE_WIDTH_MM, 20, "F");
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.text(
    toPrintable(`${a.registration} | AIRCRAFT STATUS SHEET`),
    LEFT_MM,
    10,
  );
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(BODY_FONT_PT);
  pdf.text(toPrintable(`${a.make} ${a.model} | S/N ${a.serial}`), LEFT_MM, 16);
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

function writeFooters({ pdf, aircraft }: Sheet): void {
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
      `${aircraft.registration} | Page ${page} of ${pages}`,
      RIGHT_MM,
      FOOTER_MM,
      {
        align: "right",
      },
    );
  }
}
