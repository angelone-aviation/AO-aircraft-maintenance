/**
 * Responsibility: Lays out an aircraft's AD compliance worksheet as a
 *   letter-size PDF to save or print.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/domain/airworthiness.ts,
 *   src/domain/components.ts, src/domain/model.ts.
 *
 * Follows the CompReport_N626KB.docx worksheet. It prints recorded data only:
 * blank fields and signatures are left for a person to complete.
 */
import { jsPDF } from "jspdf";
import {
  adAircraftUuid,
  adStatus,
  adTaskStatus,
  effectiveCompliance,
  type AD,
  type ADCompliance,
  type ADTask,
} from "../domain/airworthiness";
import { componentTotals, type Component } from "../domain/components";
import {
  localDate,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";

const LEFT_MM = 12.7;
const WIDTH_MM = 190.5;
const TOP_MM = 15;
const BOTTOM_MM = 261;
const LEADING_MM = 3.5;
const PADDING_MM = 1;
const BODY_FONT_PT = 8;
const LINE_HEIGHT_FACTOR = LEADING_MM / ((BODY_FONT_PT * 25.4) / 72);
const MIN_ROW_MM = 5.2;
const ROW_DASH = [0.3, 0.6];
// The section label band, left of the three header cells.
const SECTION_BAND_MM = (WIDTH_MM * 2) / 15;
const SIGN_OFF_ROW_MM = 6;
const SIGN_OFF_LABELS = ["Prepared by:", "Cert #:", "Date:"];
// A row taller than a page under the header is split where it falls rather
// than moved whole to a fresh page.
const HEADER_ALLOWANCE_MM = 45;
// Starts an AD on a new page unless its first rows fit.
const AD_START_SPACE_MM = 38;
const AD_GAP_MM = 3;
const FOOTER_MM = 269;
const DISCLAIMER_MM = 273;
const SECTION_ORDER = ["Airframe", "Engine", "Propeller", "Appliance"];
// Long enough for the new tab to load the PDF before its URL is released.
const BLOB_URL_LIFETIME_MS = 120000;

type Cell = { text: string; share: number; bold?: boolean };

/** Layout state while one worksheet is written. */
type Sheet = {
  pdf: jsPDF;
  snapshot: Snapshot;
  aircraft: Aircraft;
  y: number;
  group: AD[];
  continuedAD: string;
};

/**
 * Builds the AD compliance worksheet for one aircraft: its ADs (including
 * those on installed components) grouped by section, then component, then AD
 * number, each group starting a page under its own header. Corrected
 * compliance entries replace the originals, which are printed with them.
 *
 * @param s - Snapshot holding the aircraft, ADs, components and work orders.
 * @param aircraftUuid - The aircraft to report on.
 * @returns The document and its file name, `AD-Compliance-<registration>-
 *   <today>.pdf`.
 * @throws {Error} "Aircraft not found." when the snapshot lacks the aircraft.
 */
export function adReport(s: Snapshot, aircraftUuid: string) {
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!aircraft) throw Error("Aircraft not found.");
  const pdf = new jsPDF({ unit: "mm", format: "letter" });
  const sheet: Sheet = {
    pdf,
    snapshot: s,
    aircraft,
    y: TOP_MM,
    group: [],
    continuedAD: "",
  };
  const records = listRecords(s, aircraftUuid);
  if (!records.length) writeNoRecordsNotice(sheet);
  for (const group of groupRecords(records)) writeGroup(sheet, group);
  writeFooters(pdf, aircraft.registration);
  return {
    pdf,
    filename: `AD-Compliance-${aircraft.registration}-${localDate()}.pdf`,
  };
}

/**
 * Downloads the {@link adReport} worksheet under its file name.
 *
 * @param s - Snapshot holding the aircraft and its ADs.
 * @param id - The aircraft's uuid.
 * @throws {Error} "Aircraft not found." when the snapshot lacks the aircraft.
 */
export function saveADReport(s: Snapshot, id: string) {
  const { pdf, filename } = adReport(s, id);
  pdf.save(filename);
}

/**
 * Opens the {@link adReport} worksheet in a tab, set to print on load. The
 * tab's object URL is revoked after two minutes.
 *
 * @param s - Snapshot holding the aircraft and its ADs.
 * @param id - The aircraft's uuid.
 * @param opened - A tab opened in the click handler. Pass it when this module
 *   is loaded on demand: browsers block pop-ups opened after an await.
 * @throws {Error} "Allow pop-ups to print the report." when there is no tab;
 *   any {@link adReport} error, after closing the tab.
 */
export function printADReport(
  s: Snapshot,
  id: string,
  opened: Window | null = window.open("", "_blank"),
) {
  if (!opened) throw Error("Allow pop-ups to print the report.");
  try {
    const { pdf } = adReport(s, id);
    pdf.autoPrint();
    const url = URL.createObjectURL(pdf.output("blob"));
    opened.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
  } catch (e) {
    opened.close();
    throw e;
  }
}

function cell(text: string, share = 1, bold = false): Cell {
  return { text, share, bold };
}

function formatDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${Number(value.slice(5, 7))}/${Number(value.slice(8))}/${value.slice(0, 4)}`
    : value;
}

function formatHours(value: number | null | undefined): string {
  return value == null ? "" : value.toFixed(1);
}

function listRecords(s: Snapshot, aircraftUuid: string): AD[] {
  return (s.airworthiness ?? [])
    .filter((r) => adAircraftUuid(s, r) === aircraftUuid)
    .sort(
      (x, z) =>
        SECTION_ORDER.indexOf(x.source.section) -
          SECTION_ORDER.indexOf(z.source.section) ||
        x.componentUuid.localeCompare(z.componentUuid) ||
        x.source.number.localeCompare(z.source.number, undefined, {
          numeric: true,
        }),
    );
}

function groupRecords(records: AD[]): Iterable<AD[]> {
  const groups = new Map<string, AD[]>();
  for (const r of records) {
    const key = `${r.source.section}:${r.componentUuid}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return groups.values();
}

function writeNoRecordsNotice(sheet: Sheet): void {
  writeHeader(sheet);
  writeRow(sheet, [
    cell(
      "No AD records have been entered for this aircraft. This does not establish that no ADs apply.",
    ),
  ]);
}

function writeGroup(sheet: Sheet, group: AD[]): void {
  sheet.group = group;
  sheet.continuedAD = "";
  if (sheet.y > TOP_MM) {
    sheet.pdf.addPage();
    sheet.y = TOP_MM;
  }
  writeHeader(sheet);
  for (const r of group) writeEntry(sheet, r);
  sheet.continuedAD = "";
  writeRow(sheet, [
    cell(
      `Number of ADs: ${group.length} recorded for this ${group[0].source.section.toLowerCase()}.`,
    ),
  ]);
}

function writeEntry(sheet: Sheet, r: AD): void {
  sheet.continuedAD = "";
  if (sheet.y + AD_START_SPACE_MM > BOTTOM_MM) startPage(sheet);
  sheet.continuedAD = r.source.number;
  // Corrections replace the entries they correct; originals are listed
  // with them below.
  const history = effectiveCompliance(r);
  const latest = [...history]
    .sort((x, z) => x.date.localeCompare(z.date) || x.recordedAt - z.recordedAt)
    .at(-1);
  writeSourceRows(sheet, r, latest);
  writeLatestComplianceRows(sheet, r, latest);
  writeApplicabilityRows(sheet, r);
  for (const t of r.tasks) writeTaskRows(sheet, r, t);
  for (const h of history) writeComplianceRows(sheet, r, h, latest);
  sheet.y += AD_GAP_MM;
}

function writeSourceRows(sheet: Sheet, r: AD, latest?: ADCompliance): void {
  const hours =
    latest?.hours ??
    (r.componentUuid
      ? r.priorCompliance?.componentHours
      : r.priorCompliance?.aircraftHours);
  const due = r.tasks
    .map((t) => listDueParts(t, "cyc").join(" / "))
    .filter(Boolean)
    .join("; ");
  const noDue = ["Not applicable", "Superseded"].includes(r.applicability)
    ? "N/A"
    : "Not set";
  writeRow(sheet, [
    cell(r.source.number, 0.2, true),
    cell(`Amdt: ${r.source.amendment}`, 0.16),
    cell(`Iss: ${formatDate(r.source.issued)}`, 0.16),
    cell(`Eff: ${formatDate(r.source.effective)}`, 0.16),
    cell(`Recurring: ${r.source.recurring}`, 0.16),
    cell(`Hrs: ${formatHours(hours)}`, 0.16),
  ]);
  writeRow(sheet, [
    cell(`Subject: ${r.source.subject}`, 0.52),
    cell(`Superseded by: ${r.source.supersededBy}`, 0.32),
    cell(`Due: ${due || noDue}`, 0.16),
  ]);
}

function writeLatestComplianceRows(
  sheet: Sheet,
  r: AD,
  latest?: ADCompliance,
): void {
  const date = latest?.date || r.priorCompliance?.date || "";
  writeRow(sheet, [
    cell(`Method: ${latest?.method || ""}`, 0.84),
    cell(`SB #: ${latest?.serviceBulletin || ""}`, 0.16),
  ]);
  writeRow(sheet, [
    cell(`Terminated by: ${latest?.terminatedBy || ""}`, 0.84),
    cell("SB #:", 0.16),
  ]);
  writeRow(sheet, [
    cell(`Name: ${latest?.mechanic || ""}`, 0.36),
    cell("Sig:", 0.32),
    cell(`Cert: ${latest?.certificate || ""}`, 0.16),
    cell(`Date: ${formatDate(date)}`, 0.16),
  ]);
}

function writeApplicabilityRows(sheet: Sheet, r: AD): void {
  const reason = r.reason ? " - " + r.reason : "";
  writeRow(sheet, [
    cell(
      `Applicability: ${r.applicability}${reason} | Status: ${adStatus(sheet.snapshot, r)}`,
    ),
  ]);
  const prior = r.priorCompliance;
  if (!prior) return;
  const componentTime = r.componentUuid
    ? " | Component total time: " +
      (formatHours(prior.componentHours) || "Not recorded") +
      " h"
    : "";
  writeRow(sheet, [
    cell(
      `Previously Complied With (PCW): ${formatDate(prior.date)} | Aircraft total time: ${formatHours(prior.aircraftHours) || "Not recorded"} h${componentTime}`,
    ),
  ]);
}

function writeTaskRows(sheet: Sheet, r: AD, t: ADTask): void {
  const repeat = [
    t.intervalDays && t.intervalDays + " days",
    t.intervalHours && t.intervalHours + " h",
    t.intervalCycles && t.intervalCycles + " cycles",
    t.intervalLandings && t.intervalLandings + " landings",
  ].filter(Boolean);
  const status = adTaskStatus(sheet.snapshot, r, t);
  writeRow(sheet, [cell(`Required action: ${t.description} | ${status}`)]);
  writeRow(sheet, [
    cell(
      `Due: ${listDueParts(t, "cycles").join(" / ") || "Not set"} | Repeat: ${repeat.join(" / ") || "None recorded"}`,
    ),
  ]);
}

function listDueParts(t: ADTask, cyclesUnit: "cyc" | "cycles"): string[] {
  return [
    t.dueDate && formatDate(t.dueDate),
    t.dueHours != null && `${formatHours(t.dueHours)} h`,
    t.dueCycles != null && `${t.dueCycles} ${cyclesUnit}`,
    t.dueLandings != null && `${t.dueLandings} landings`,
  ].filter((part): part is string => Boolean(part));
}

function writeComplianceRows(
  sheet: Sheet,
  r: AD,
  h: ADCompliance,
  latest?: ADCompliance,
): void {
  const workOrder = sheet.snapshot.workOrders?.find(
    (w) => w.uuid === h.workOrderUuid,
  );
  writeRow(sheet, [
    cell(
      `Compliance record: ${formatDate(h.date)} | ${formatHours(h.hours) || "Unrecorded"} h | Cycles: ${h.cycles ?? "Unrecorded"} | Work order: ${workOrder?.number || h.workOrderUuid || "Unrecorded"}`,
    ),
  ]);
  const original = h.corrects
    ? r.history.find((x) => x.uuid === h.corrects)
    : undefined;
  if (original) writeCorrectionRow(sheet, h, original);
  if (h !== latest) {
    writeRow(sheet, [
      cell(
        `Method: ${h.method} | SB #: ${h.serviceBulletin} | Terminated by: ${h.terminatedBy}`,
      ),
    ]);
    writeRow(sheet, [cell(`Name: ${h.mechanic} | Cert: ${h.certificate}`)]);
  }
  if (h.evidence)
    writeRow(sheet, [cell(`Evidence / logbook reference: ${h.evidence}`)]);
}

function writeCorrectionRow(
  sheet: Sheet,
  h: ADCompliance,
  original: ADCompliance,
): void {
  writeRow(sheet, [
    cell(
      `Corrected ${formatDate(localDate(h.recordedAt))}: ${h.correctionReason ?? ""} | Originally recorded: ${formatDate(original.date)} | ${formatHours(original.hours) || "Unrecorded"} h | Cycles: ${original.cycles ?? "Unrecorded"} | Method: ${original.method} | Name: ${original.mechanic}`,
    ),
  ]);
}

function writeHeader(sheet: Sheet): void {
  const { pdf, y } = sheet;
  const r = sheet.group.at(0);
  const info = listHeaderCells(sheet, findComponent(sheet.snapshot, r));
  const chunks = info.map((c) => wrapCell(pdf, c));
  const h = Math.max(10, ...chunks.map((l) => l.length * LEADING_MM + 2));
  drawSectionBand(pdf, r?.source.section ?? "Airframe", y, h);
  let x = LEFT_MM + SECTION_BAND_MM;
  info.forEach((c, i) => {
    pdf.rect(x, y, WIDTH_MM * c.share, h);
    pdf.setFontSize(BODY_FONT_PT);
    pdf.setFont("helvetica", "normal");
    pdf.text(chunks[i], x + 1, y + 3.7, {
      lineHeightFactor: LINE_HEIGHT_FACTOR,
    });
    pdf.rect(x, y + h, WIDTH_MM * c.share, SIGN_OFF_ROW_MM);
    pdf.text(SIGN_OFF_LABELS[i], x + 1, y + h + 4);
    x += WIDTH_MM * c.share;
  });
  sheet.y += h + 10;
}

function findComponent(s: Snapshot, r?: AD): Component | undefined {
  const c = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r?.componentUuid,
  );
  return c?.kind === "component" ? c : undefined;
}

function listHeaderCells(sheet: Sheet, component?: Component): Cell[] {
  const a = sheet.aircraft;
  if (!component)
    return [
      cell(`Make: ${a.make}\nModel: ${a.model}`, 1 / 3),
      cell(`Serial: ${a.serial || ""}\nN-No.: ${a.registration}`, 4 / 15),
      cell(
        `Total AC Hours: ${formatHours(totalSeconds(a) / 3600)}\nHrs. Since Last:`,
        4 / 15,
      ),
    ];
  const model = component.faaSearchModel || component.model || a.model;
  return [
    cell(`Make: ${component.manufacturer || a.make}\nModel: ${model}`, 1 / 3),
    cell(
      `Serial: ${component.serial || a.serial || ""}\nLabel: ${component.installPosition || ""}`,
      4 / 15,
    ),
    cell(
      `Hours (TSN): ${componentHours(component, a)}\nN-No.: ${a.registration}`,
      4 / 15,
    ),
  ];
}

function componentHours(component: Component, a: Aircraft): string {
  try {
    return formatHours(componentTotals(component, a).timeSinceNew / 3600);
  } catch {
    // Usage that cannot be computed (readings before the installation
    // baseline) must not stop the worksheet printing.
    return "Unavailable";
  }
}

function drawSectionBand(pdf: jsPDF, section: string, y: number, h: number) {
  pdf.setFillColor(0, 0, 0);
  pdf.rect(LEFT_MM, y, SECTION_BAND_MM, h + SIGN_OFF_ROW_MM, "F");
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(255);
  pdf.text(section, LEFT_MM + WIDTH_MM / 15, y + (h + SIGN_OFF_ROW_MM) / 2, {
    align: "center",
  });
  pdf.setTextColor(0);
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.15);
}

function startPage(sheet: Sheet): void {
  sheet.pdf.addPage();
  sheet.y = TOP_MM;
  writeHeader(sheet);
  if (!sheet.continuedAD) return;
  sheet.pdf.setFont("helvetica", "bold");
  sheet.pdf.setFontSize(BODY_FONT_PT);
  sheet.pdf.text(`AD ${sheet.continuedAD} (continued)`, LEFT_MM, sheet.y + 3);
  sheet.y += 6;
}

function wrapCell(pdf: jsPDF, c: Cell): string[] {
  pdf.setFont("helvetica", c.bold ? "bold" : "normal");
  pdf.setFontSize(BODY_FONT_PT);
  return pdf.splitTextToSize(
    c.text || " ",
    WIDTH_MM * c.share - PADDING_MM * 2,
  ) as string[];
}

// Splits a row across pages when it is taller than the space left.
function writeRow(sheet: Sheet, cells: Cell[]): void {
  const wrapped = cells.map((c) => wrapCell(sheet.pdf, c));
  const n = Math.max(...wrapped.map((l) => l.length));
  const height = Math.max(MIN_ROW_MM, n * LEADING_MM + 2);
  if (height <= BOTTOM_MM - HEADER_ALLOWANCE_MM && sheet.y + height > BOTTOM_MM)
    startPage(sheet);
  let offset = 0;
  while (offset < n) {
    let available = countFreeLines(sheet);
    if (available < 1) {
      startPage(sheet);
      available = countFreeLines(sheet);
    }
    const count = Math.min(n - offset, available);
    const chunks = wrapped.map((l) => l.slice(offset, offset + count));
    drawRow(sheet, cells, chunks, count);
    offset += count;
    if (offset < n) startPage(sheet);
  }
}

function countFreeLines(sheet: Sheet): number {
  return Math.floor((BOTTOM_MM - sheet.y - 2) / LEADING_MM);
}

function drawRow(
  sheet: Sheet,
  cells: Cell[],
  chunks: string[][],
  count: number,
): void {
  const { pdf } = sheet;
  const h = Math.max(MIN_ROW_MM, count * LEADING_MM + PADDING_MM * 2);
  let x = LEFT_MM;
  pdf.setDrawColor(90);
  pdf.setLineWidth(0.12);
  pdf.setLineDashPattern(ROW_DASH, 0);
  cells.forEach((c, i) => {
    const w = WIDTH_MM * c.share;
    pdf.rect(x, sheet.y, w, h);
    pdf.setFont("helvetica", c.bold ? "bold" : "normal");
    pdf.setFontSize(BODY_FONT_PT);
    pdf.setTextColor(0);
    pdf.text(chunks[i], x + PADDING_MM, sheet.y + PADDING_MM + 2.7, {
      lineHeightFactor: LINE_HEIGHT_FACTOR,
    });
    x += w;
  });
  sheet.y += h;
  pdf.setLineDashPattern([], 0);
}

function writeFooters(pdf: jsPDF, registration: string): void {
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(70);
    pdf.text(
      `${registration} | AD Compliance Report | ${localDate()}`,
      LEFT_MM,
      FOOTER_MM,
    );
    pdf.text(`Page ${p} of ${pages}`, LEFT_MM + WIDTH_MM, FOOTER_MM, {
      align: "right",
    });
    pdf.text(
      "Recorded information only. Blank fields are not certification of compliance. Signatures are not generated.",
      LEFT_MM,
      DISCLAIMER_MM,
    );
  }
}
