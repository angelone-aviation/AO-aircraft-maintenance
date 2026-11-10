/**
 * Responsibility: Chooses what one aircraft's records package holds: the
 *   status sheet, flights, discrepancies, work orders, AD compliance,
 *   components, Form 337 copies and the change log as tables of text, the
 *   stored files to copy in (within a size limit), and the README.
 * Layer: Domain. Pure functions; no I/O and no layout.
 * Dependencies: src/domain (statusSheet, model, auditHistory, logbook,
 *   adCompliance, adOwnership, components, aircraftFiles, flights, rejection,
 *   workOrders and airworthiness types).
 *
 * The package serves FAA inspection access (14 CFR 91.417(c)) and transfer
 * with the aircraft at sale (91.419), as ADR-0004 decided. It copies what is
 * recorded; the signed entries in the aircraft's logbooks stay the
 * maintenance record.
 */
import type {
  Aircraft,
  AuditEntry,
  Discrepancy,
  Flight,
  Snapshot,
} from "./model";
import { can } from "./model";
import { statusSheet, type StatusSectionId } from "./statusSheet";
import { auditActionLabel } from "./auditHistory";
import { logbookRecordText } from "./logbook";
import { adAircraftUuid } from "./adOwnership";
import type { AD, ADCompliance } from "./airworthiness";
import {
  componentTotals,
  requirementDueDate,
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "./components";
import { isCurrentAircraftFile, type AircraftFile } from "./aircraftFiles";
import { flightStatusLabels } from "./flights";
import type { WorkOrder } from "./workOrders";
import { Rejection } from "./rejection";

const SECONDS_PER_HOUR = 3600;
const BYTES_PER_KB = 1024;
const MEGABYTE = 1024 * 1024;
const NOT_TRACKED = "Not tracked";
const REVIEW = "Review";

/**
 * The most file bytes a package copies in. Browsers build the ZIP in memory,
 * and a records request is served in several packages above this.
 */
export const MAX_PACKAGE_FILE_BYTES = 150 * MEGABYTE;

/** The CSV file of each status sheet section. */
const STATUS_FILES: Record<StatusSectionId, string> = {
  overview: "status-overview.csv",
  components: "status-components.csv",
  inspections: "status-inspections.csv",
  airworthiness: "status-airworthiness.csv",
  form337: "status-form-337.csv",
  discrepancies: "status-discrepancies.csv",
};

/**
 * Names a table of the package, so a layout can size its columns; the status
 * sheet's tables keep their own ids behind "status.".
 */
export type RecordsSectionId =
  | `status.${StatusSectionId}`
  | "flights"
  | "discrepancies"
  | "workOrders"
  | "adCompliance"
  | "components"
  | "componentRequirements"
  | "form337Copies"
  | "changeLog";

/** One table of the package: printed in the PDF and written as one CSV. */
export interface RecordsSection {
  id: RecordsSectionId;
  title: string;
  /** The section's CSV file name in the package, such as "flights.csv". */
  file: string;
  columns: string[];
  /** One cell per column; an empty table holds one placeholder row. */
  rows: string[][];
  notes: string[];
  /**
   * What a reader must know before trusting the rows, such as a partial
   * change log: also in the notes, first in the CSV and in the README.
   */
  warning?: string;
}

/** A stored file the package copies in, fetched by its URL. */
export interface PackageFile {
  /** Where it goes in the package, such as "form-337/2026-03-01-repair.pdf". */
  path: string;
  url: string;
  size: number;
  /** What it is, for the README: "Form 337 copy", "Work order WO-… attachment". */
  description: string;
}

/** A file left out of the package and why. */
export interface SkippedFile {
  file: PackageFile;
  reason: string;
}

/** The change log rows for the aircraft and whether they are all of them. */
export interface ChangeLogRows {
  entries: AuditEntry[];
  complete: boolean;
  /**
   * The entries are the recent ones kept on the device, read offline; an
   * incomplete log without it was cut at the newest entries one package
   * reads.
   */
  fromDevice?: boolean;
}

/** What one aircraft's records package holds, before files are fetched. */
export interface RecordsPackage {
  aircraft: {
    registration: string;
    makeModel: string;
    serial: string;
    program: string;
  };
  sections: RecordsSection[];
  /** Every stored file of the aircraft, in package order, before the limit. */
  files: PackageFile[];
}

/**
 * Builds the records package content for one aircraft as recorded in `s`.
 *
 * @param s - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft.
 * @param today - Local `YYYY-MM-DD` that due dates are counted from.
 * @param changeLog - The aircraft's change log, oldest or newest first.
 * @returns The six {@link statusSheet} sections, then flights oldest first,
 *   every discrepancy oldest first, work orders by date opened, AD
 *   compliance entries by AD number in history order (corrections included),
 *   every component ever on the aircraft, their requirements, every Form 337
 *   copy (archived ones too) oldest upload first, and the change log oldest
 *   first; and the Form 337 copies then work-order attachments as files.
 *   A component whose usage cannot be computed reads "Review".
 * @throws {Rejection} "Aircraft not found." when `s` lacks the aircraft; as
 *   {@link assertRecordsExporter}; what {@link statusSheet} throws.
 */
export function buildRecordsPackage(
  s: Snapshot,
  aircraftUuid: string,
  today: string,
  changeLog: ChangeLogRows,
): RecordsPackage {
  const a = s.aircraft.find((x) => x.uuid === aircraftUuid);
  if (!a) throw new Rejection("Aircraft not found.");
  assertRecordsExporter(s, aircraftUuid);
  const status = statusSheet(s, aircraftUuid, today);
  const components = (s.management ?? []).filter(
    (c): c is Component => c.kind === "component" && c.aircraftUuid === a.uuid,
  );
  const orders = aircraftWorkOrders(s, a);
  return {
    aircraft: { ...status.header, program: a.program },
    sections: [
      ...status.sections.map((x) => ({
        ...x,
        id: `status.${x.id}` as const,
        file: STATUS_FILES[x.id],
      })),
      flightsSection(s, a),
      discrepanciesSection(s, a),
      workOrdersSection(s, orders),
      adComplianceSection(s, a, orders),
      componentsSection(components, a, today),
      requirementsSection(s, components, a, today),
      form337Section(s, a),
      changeLogSection(s, changeLog),
    ],
    files: [...form337Files(s, a), ...attachmentFiles(s, orders)],
  };
}

/**
 * Checks that the signed-in user may export the aircraft's records package:
 * mechanics with maintenance permission on it, and program and system
 * administrators. The package is assembled in the browser from records the
 * user can already read, so this is where the rule holds.
 *
 * @param s - The exporter's snapshot.
 * @param aircraftUuid - The aircraft.
 * @throws {Rejection} "Records packages are for users with maintenance
 *   permission on the aircraft." for anyone else.
 */
export function assertRecordsExporter(s: Snapshot, aircraftUuid: string) {
  if (!can(s, aircraftUuid, "maintenance"))
    throw new Rejection(
      "Records packages are for users with maintenance permission on the aircraft.",
    );
}

/**
 * Decides which files fit the package: files are taken in order while the
 * total stays within the limit; one that would exceed it is skipped and the
 * later, smaller ones may still be taken.
 *
 * @param files - The package's files in order.
 * @param limit - The most bytes to take; {@link MAX_PACKAGE_FILE_BYTES}.
 * @returns The files to fetch, and the skipped ones with the reason
 *   "Over the 150 MB package limit".
 */
export function planPackageFiles(
  files: PackageFile[],
  limit = MAX_PACKAGE_FILE_BYTES,
): { included: PackageFile[]; skipped: SkippedFile[] } {
  const included: PackageFile[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;
  const reason = `Over the ${limit / MEGABYTE} MB package limit`;
  for (const file of files) {
    if (total + file.size > limit) {
      skipped.push({ file, reason });
      continue;
    }
    total += file.size;
    included.push(file);
  }
  return { included, skipped };
}

/**
 * The package's file name.
 *
 * @param registration - The aircraft's registration; characters other than
 *   letters, digits and "-" become "_".
 * @param today - Local `YYYY-MM-DD`.
 * @returns `<registration>-records-<today>.zip`.
 */
export function recordsPackageName(registration: string, today: string) {
  return `${registration.replace(/[^a-z0-9-]/gi, "_")}-records-${today}.zip`;
}

/**
 * The README that explains the package to an inspector, buyer or insurer.
 *
 * @param pkg - The package content.
 * @param generated - When it was generated, as text, and the user's name.
 * @param skipped - Files left out, with why; "None." when empty.
 * @returns Plain text: identity, purpose and the legal note, a WARNINGS
 *   block when a table is incomplete (such as a partial change log), one
 *   line per file and folder, then the skipped files.
 */
export function recordsReadme(
  pkg: RecordsPackage,
  generated: { at: string; by: string },
  skipped: SkippedFile[],
): string {
  const { aircraft } = pkg;
  const warnings = pkg.sections.flatMap((x) => (x.warning ? [x.warning] : []));
  return [
    "ANGEL ONE RECORDS PACKAGE",
    `Aircraft: ${aircraft.registration} - ${aircraft.makeModel}, S/N ${aircraft.serial}`,
    `Flight Program: ${aircraft.program}`,
    `Generated: ${generated.at} by ${generated.by}`,
    "",
    `The records Angel One holds for this aircraft, for inspection under 14 CFR 91.417(c) or transfer with the aircraft under 14 CFR 91.419. Angel One is the system of record for the six status records of 91.417(a)(2); the signed entries in the aircraft's logbooks remain the maintenance record. Values are as recorded when the package was generated. Corrections are appended in Angel One with a reason and never edited into history, so ${warnings.length ? "Angel One's change log lists every change; this package's copy of it is partial (see WARNINGS)." : "the change log lists every change."}`,
    "",
    ...(warnings.length ? ["WARNINGS", ...warnings, ""] : []),
    "FILES",
    "records.pdf - Every table below as a printable document.",
    ...pkg.sections.map(
      (x) =>
        `${x.file} - ${x.title} (${countRows(x)})${x.warning ? ", partial: see WARNINGS" : ""}.`,
    ),
    "form-337/ - Copies of FAA Form 337 on the aircraft record, named <upload date (UTC)>-<file name>; archived copies are under form-337/archived/.",
    "files/ - Attachments of the aircraft's work orders, named <upload date (UTC)>-<file name>.",
    "",
    "CSV files are UTF-8 with a byte-order mark; every cell is quoted, and text that a spreadsheet would run as a formula starts with an apostrophe.",
    "Times, and the dates in file names, are UTC, as the column headings say; a date without a time (a work order's dates, a deferral, a due date) is the calendar date as recorded.",
    "",
    "SKIPPED FILES",
    ...(skipped.length
      ? skipped.map(
          (x) => `${x.file.path} - ${x.file.description}: ${x.reason}.`,
        )
      : ["None."]),
    "",
  ].join("\n");
}

// A placeholder row is not a record.
function countRows(section: RecordsSection): string {
  const n = section.rows.filter((r) => !isPlaceholder(r)).length;
  return `${n} ${n === 1 ? "row" : "rows"}`;
}

function isPlaceholder(row: string[]): boolean {
  const text = row.filter((cell) => cell !== "-");
  return text.length === 1 && text[0].startsWith("No ");
}

function aircraftWorkOrders(s: Snapshot, a: Aircraft): WorkOrder[] {
  return (s.workOrders ?? [])
    .filter((w) => w.aircraftUuid === a.uuid)
    .sort(
      (x, z) =>
        x.dateOpened.localeCompare(z.dateOpened) || x.recordedAt - z.recordedAt,
    );
}

function flightsSection(s: Snapshot, a: Aircraft): RecordsSection {
  const flights = s.flights
    .filter((f) => f.aircraftUuid === a.uuid)
    .sort((x, z) => Date.parse(x.startTime) - Date.parse(z.startTime));
  const columns = [
    "Start (UTC)",
    "Pilot",
    "Route",
    "Hobbs start / end",
    "Tach start / end",
    "Other meters",
    "Landings",
    "Cycles",
    "Oil added",
    "Status",
    "Remarks",
  ];
  return {
    id: "flights",
    title: "Flights",
    file: "flights.csv",
    columns,
    rows: flights.length
      ? flights.map((f) => flightRow(s, f))
      : [placeholder("No flights recorded", columns.length)],
    notes: [
      "Start readings are the aircraft's when the flight was submitted; end readings are the pilot's. A held flight awaits an administrator's review and has not advanced the counters.",
    ],
  };
}

function flightRow(s: Snapshot, f: Flight): string[] {
  const names = [f.pilotId, f.copilotId]
    .filter((id): id is string => !!id)
    .map((id) => memberName(s, id));
  const status = f.reviewReason
    ? `${flightStatusLabels[f.status]}: ${f.reviewReason}`
    : flightStatusLabels[f.status];
  return [
    formatStart(f.startTime),
    names.join(" / "),
    `${f.origin} - ${f.destination}`,
    `${formatHours(f.hobbsOff)} / ${formatHours(f.hobbsOn)}`,
    `${formatHours(f.tachOff)} / ${formatHours(f.tachOn)}`,
    otherMeters(f) || "-",
    String(f.landings),
    String(f.cycles),
    oilAdded(f) || "-",
    status,
    f.remarks,
  ];
}

function otherMeters(f: Flight): string {
  const parts = [
    f.cyclicHobbsOff !== undefined || f.cyclicHobbsOn !== undefined
      ? `Collective ${formatHours(f.cyclicHobbsOff)} / ${formatHours(f.cyclicHobbsOn)}`
      : "",
    f.flightTimeLogOff !== undefined || f.flightTimeLogOn !== undefined
      ? `Flight time log ${formatHours(f.flightTimeLogOff)} / ${formatHours(f.flightTimeLogOn)}`
      : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function oilAdded(f: Flight): string {
  return (f.oil ?? [])
    .filter((o) => o.added !== undefined)
    .map((o) => {
      const unit = o.addedUnit ?? (o.unit === "range" ? "" : o.unit);
      const engine = o.engine === "single" ? "" : `${o.engine} `;
      return `${engine}${o.added} ${unit}`.trim();
    })
    .join("\n");
}

function discrepanciesSection(s: Snapshot, a: Aircraft): RecordsSection {
  const reports = s.discrepancies
    .filter((d) => d.aircraftUuid === a.uuid)
    .sort((x, z) => x.createdAt - z.createdAt);
  const columns = [
    "Reported (UTC)",
    "Reported by",
    "Description",
    "Grounding",
    "Deferral",
    "Status",
    "Resolved (UTC)",
    "Resolved by",
    "Resolution",
  ];
  return {
    id: "discrepancies",
    title: "Discrepancies",
    file: "discrepancies.csv",
    columns,
    rows: reports.length
      ? reports.map((d) => discrepancyRow(s, d))
      : [placeholder("No discrepancies recorded", columns.length)],
    notes: [],
  };
}

function discrepancyRow(s: Snapshot, d: Discrepancy): string[] {
  return [
    formatUtc(d.createdAt),
    memberName(s, d.authorId),
    d.description,
    d.grounding ? "Yes" : "No",
    describeDeferral(d),
    d.status === "open" ? "Open" : "Resolved",
    d.resolvedAt === undefined ? "-" : formatUtc(d.resolvedAt),
    d.resolvedBy ? memberName(s, d.resolvedBy) : "-",
    d.resolution ?? "-",
  ];
}

function describeDeferral(d: Discrepancy): string {
  const x = d.deferral;
  if (!x) return "-";
  const basis =
    x.type === "mel"
      ? `MEL item ${x.melItem}, category ${x.category}`
      : "14 CFR 91.213(d)";
  return [
    `${basis}; deferred ${x.deferredOn} by ${x.deferredByName}`,
    x.expiresOn ? `expires ${x.expiresOn}` : "",
    x.placard ? `placard: ${x.placard}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function workOrdersSection(s: Snapshot, orders: WorkOrder[]): RecordsSection {
  const columns = [
    "Work order",
    "Opened",
    "Completed",
    "Status",
    "Priority",
    "Scope",
    "Supervisor",
    "Release outcome",
    "Logbook entry",
  ];
  return {
    id: "workOrders",
    title: "Work orders",
    file: "work-orders.csv",
    columns,
    rows: orders.length
      ? orders.map((w) => workOrderRow(s, w))
      : [placeholder("No work orders recorded", columns.length)],
    notes: [
      "The logbook entry is the unsigned text generated when the order was completed, frozen at close-out, without its certification lines. The signed entry in the aircraft logbook is the maintenance record.",
    ],
  };
}

function workOrderRow(s: Snapshot, w: WorkOrder): string[] {
  return [
    w.number || "(no number)",
    w.dateOpened,
    w.completionDate || "-",
    w.status,
    w.priority,
    w.scope,
    w.supervisor,
    w.releaseOutcome,
    w.status === "completed" ? logbookRecordText(s, w) : "-",
  ];
}

function adComplianceSection(
  s: Snapshot,
  a: Aircraft,
  orders: WorkOrder[],
): RecordsSection {
  const ads = (s.airworthiness ?? [])
    .filter((r) => adAircraftUuid(s, r) === a.uuid)
    .sort((x, z) =>
      x.source.number.localeCompare(z.source.number, undefined, {
        numeric: true,
      }),
    );
  const columns = [
    "AD number",
    "Subject",
    "Required action",
    "Date",
    "Hours",
    "Cycles",
    "Landings",
    "Method",
    "Service bulletin / terminated by",
    "Mechanic / certificate",
    "Work order",
    "Record",
  ];
  const rows = ads.flatMap((r) => complianceRows(r, orders));
  return {
    id: "adCompliance",
    title: "AD compliance history",
    file: "ad-compliance.csv",
    columns,
    rows: rows.length
      ? rows
      : [placeholder("No AD compliance recorded", columns.length)],
    notes: [
      "Every compliance entry is listed, including entries later corrected: a correction names the entry it replaces and the original stays (ADR-0005). Current AD status is in the Airworthiness directives table.",
    ],
  };
}

function complianceRows(r: AD, orders: WorkOrder[]): string[][] {
  const superseded = new Set(r.history.map((h) => h.corrects).filter(Boolean));
  return r.history.map((h) => [
    r.source.number,
    r.source.subject,
    r.tasks.find((t) => t.uuid === h.taskUuid)?.description ?? "-",
    h.date,
    h.hours === null ? "-" : h.hours.toFixed(1),
    h.cycles === null ? "-" : String(h.cycles),
    h.landings == null ? "-" : String(h.landings),
    h.method,
    [h.serviceBulletin, h.terminatedBy].filter(Boolean).join("\n") || "-",
    [h.mechanic, h.certificate].filter(Boolean).join("\n"),
    orders.find((w) => w.uuid === h.workOrderUuid)?.number || "-",
    describeComplianceRecord(r, h, superseded.has(h.uuid)),
  ]);
}

function describeComplianceRecord(
  r: AD,
  h: ADCompliance,
  superseded: boolean,
): string {
  const corrected = r.history.find((x) => x.uuid === h.corrects);
  const parts = [
    h.corrects
      ? `Corrects the entry of ${corrected?.date ?? "an earlier date"}: ${h.correctionReason ?? ""}`.trim()
      : "Original",
    superseded ? "Superseded by a correction" : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function componentsSection(
  components: Component[],
  a: Aircraft,
  today: string,
): RecordsSection {
  const columns = [
    "Position / component",
    "Manufacturer / part number / model",
    "Serial number",
    "Installed",
    "Removed",
    "TSN hours",
    "TSO hours",
    "TSR hours",
    "Cycles",
    "Tracking",
  ];
  const sorted = [...components].sort(
    (x, z) =>
      Number(z.installed) - Number(x.installed) ||
      x.componentType.localeCompare(z.componentType),
  );
  return {
    id: "components",
    title: "Components",
    file: "components.csv",
    columns,
    rows: sorted.length
      ? sorted.map((c) => componentRow(c, a, today))
      : [placeholder("No component records", columns.length)],
    notes: [
      "Installed components come first. A removed component keeps the totals recorded at removal.",
    ],
  };
}

function componentRow(c: Component, a: Aircraft, today: string): string[] {
  const identity = [
    `${c.installPosition ?? ""} ${c.componentType}`.trim(),
    [c.manufacturer, c.partNumber, c.model].filter(Boolean).join(" / "),
    c.serial,
    c.installedDate ?? "-",
    c.installed ? "-" : (c.removedDate ?? "Removed"),
  ];
  const tracking = [
    c.trackTime ? "time" : "",
    c.trackCycles ? "cycles" : "",
    c.trackCalendar ? "calendar" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [...identity, ...componentUsage(c, a, today), tracking || "-"];
}

// Usage that cannot be computed (readings before the installation baseline)
// is flagged for review rather than stopping the package.
function componentUsage(c: Component, a: Aircraft, today: string): string[] {
  let totals: ReturnType<typeof componentTotals>;
  try {
    totals = componentTotals(c, c.installed ? a : undefined, today);
  } catch {
    return [REVIEW, REVIEW, REVIEW, REVIEW];
  }
  return [
    c.trackTime ? formatHours(totals.timeSinceNew) : NOT_TRACKED,
    c.trackTime ? formatHours(totals.timeSinceOverhaul) : NOT_TRACKED,
    c.trackTime ? formatHours(totals.timeSinceRepair) : NOT_TRACKED,
    c.trackCycles ? String(totals.cyclesSinceNew) : NOT_TRACKED,
  ];
}

function requirementsSection(
  s: Snapshot,
  components: Component[],
  a: Aircraft,
  today: string,
): RecordsSection {
  const requirements = (s.management ?? []).filter(
    (r): r is ComponentRequirement =>
      r.kind === "componentRequirement" && r.aircraftUuid === a.uuid,
  );
  const columns = [
    "Component",
    "Requirement",
    "Description",
    "Basis",
    "Interval",
    "Last done",
    "Next due",
    "Status",
  ];
  return {
    id: "componentRequirements",
    title: "Component requirements",
    file: "component-requirements.csv",
    columns,
    rows: requirements.length
      ? requirements.map((r) => requirementRow(r, components, a, today))
      : [placeholder("No component requirements recorded", columns.length)],
    notes: [],
  };
}

function requirementRow(
  r: ComponentRequirement,
  components: Component[],
  a: Aircraft,
  today: string,
): string[] {
  const c = components.find((x) => x.uuid === r.componentUuid);
  const unit = r.calendarIntervalUnit.toLowerCase();
  return [
    c ? `${c.componentType} S/N ${c.serial}` : r.componentUuid,
    r.requirementType,
    r.description,
    r.timeBasis,
    joinLines([
      r.intervalSeconds ? `${formatHours(r.intervalSeconds)} h` : "",
      r.intervalCycles ? `${r.intervalCycles} cyc` : "",
      r.intervalLandings ? `${r.intervalLandings} landings` : "",
      r.calendarIntervalValue ? `${r.calendarIntervalValue} ${unit}` : "",
    ]),
    joinLines([
      r.lastDate ?? "",
      r.lastSeconds === undefined ? "" : `${formatHours(r.lastSeconds)} h`,
      r.lastCycles === undefined ? "" : `${r.lastCycles} cyc`,
      r.lastLandings === undefined ? "" : `${r.lastLandings} landings`,
    ]),
    joinLines([
      requirementDueDate(r) ?? "",
      r.dueSeconds === undefined ? "" : `${formatHours(r.dueSeconds)} h`,
      r.dueCycles === undefined ? "" : `${r.dueCycles} cyc`,
      r.dueLandings === undefined ? "" : `${r.dueLandings} landings`,
    ]),
    c ? requirementState(r, c, a, today) : REVIEW,
  ];
}

// As componentUsage: an uncomputable status is flagged, not fatal.
function requirementState(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft,
  today: string,
): string {
  try {
    return requirementStatus(r, c, c.installed ? a : undefined, today).status;
  } catch {
    return REVIEW;
  }
}

function form337Section(s: Snapshot, a: Aircraft): RecordsSection {
  const copies = form337Copies(s, a);
  const columns = [
    "Document",
    "Uploaded (UTC)",
    "Size",
    "Status",
    "Package file",
  ];
  return {
    id: "form337Copies",
    title: "Form 337 copies on file",
    file: "form-337.csv",
    columns,
    rows: copies.length
      ? copies.map(({ copy: f, path }) => [
          f.name,
          formatUtc(f.uploadedAt),
          `${Math.ceil(f.size / BYTES_PER_KB)} KB`,
          describeCopyStatus(f),
          path,
        ])
      : [placeholder("No Form 337 copies on file", columns.length)],
    notes: [
      "Archived copies are kept (ADR-0004) and included in the package under form-337/archived/.",
    ],
  };
}

function describeCopyStatus(f: AircraftFile): string {
  if (isCurrentAircraftFile(f)) return "Current";
  const when =
    f.archivedAt === undefined ? "" : ` ${formatUtc(f.archivedAt)} UTC`;
  return `Archived${when} by ${f.archivedBy?.name ?? "-"}: ${f.archiveReason ?? ""}`.trim();
}

// Every copy of this aircraft, oldest upload first, with its package path.
function form337Copies(s: Snapshot, a: Aircraft) {
  const copies = (s.aircraftFiles ?? [])
    .filter((f) => f.aircraftUuid === a.uuid && f.category === "form-337")
    .sort((x, z) => x.uploadedAt - z.uploadedAt);
  return uniquePaths(
    copies.map((copy) => {
      const folder = isCurrentAircraftFile(copy)
        ? "form-337"
        : "form-337/archived";
      const name = `${utcDate(copy.uploadedAt)}-${safeFileName(copy.name)}`;
      return { copy, path: `${folder}/${name}` };
    }),
  );
}

function form337Files(s: Snapshot, a: Aircraft): PackageFile[] {
  return form337Copies(s, a).map(({ copy, path }) => ({
    path,
    url: copy.url,
    size: copy.size,
    description: isCurrentAircraftFile(copy)
      ? "Form 337 copy"
      : "Form 337 copy (archived)",
  }));
}

function attachmentFiles(s: Snapshot, orders: WorkOrder[]): PackageFile[] {
  const numbers = new Map(orders.map((w) => [w.uuid, w.number]));
  return uniquePaths(
    (s.workOrderAttachments ?? [])
      .filter((f) => numbers.has(f.workOrderUuid))
      .sort((x, z) => x.uploadedAt - z.uploadedAt)
      .map((f) => ({
        path: `files/${utcDate(f.uploadedAt)}-${safeFileName(f.name)}`,
        url: f.url,
        size: f.size,
        description: `Work order ${numbers.get(f.workOrderUuid) || "(no number)"} attachment`,
      })),
  );
}

// Two uploads of one name on one day would overwrite each other in the ZIP.
function uniquePaths<T extends { path: string }>(files: T[]): T[] {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const count = (seen.get(file.path) ?? 0) + 1;
    seen.set(file.path, count);
    if (count === 1) return file;
    const dot = file.path.lastIndexOf(".");
    const hasExtension = dot > file.path.lastIndexOf("/");
    const stem = hasExtension ? file.path.slice(0, dot) : file.path;
    const extension = hasExtension ? file.path.slice(dot) : "";
    return { ...file, path: `${stem} (${count})${extension}` };
  });
}

// Keeps a file name usable on Windows, macOS and Linux once unzipped.
function safeFileName(name: string): string {
  const cleaned = Array.from(name.trim())
    .map((ch) =>
      ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? "_" : ch,
    )
    .join("");
  return cleaned || "file";
}

function changeLogSection(s: Snapshot, log: ChangeLogRows): RecordsSection {
  const entries = [...log.entries].sort((x, z) => x.at - z.at);
  const warning = changeLogWarning(log, entries.length);
  const columns = [
    "When (UTC)",
    "Action",
    "By",
    "Record",
    "Reason",
    "Before",
    "After",
  ];
  return {
    id: "changeLog",
    title: "Change log",
    file: "change-log.csv",
    columns,
    rows: entries.length
      ? entries.map((e) => [
          formatUtc(e.at),
          auditActionLabel(e.action),
          memberName(s, e.actorId),
          e.entityUuid,
          e.reason ?? "-",
          e.before ?? "-",
          e.after ?? "-",
        ])
      : [placeholder("No changes recorded", columns.length)],
    notes: [
      warning ?? `${entries.length} entries; the change log is append-only.`,
    ],
    warning,
  };
}

// Says plainly what an incomplete change log leaves out, and what to do.
function changeLogWarning(log: ChangeLogRows, count: number) {
  if (log.complete) return undefined;
  const entries = `${count} ${count === 1 ? "entry" : "entries"}`;
  if (log.fromDevice)
    return `Partial change log: ${entries}, only the recent changes kept on the exporting device, which was offline. Angel One holds the complete change log; export again while connected to include it.`;
  return `Partial change log: the newest ${entries}. The change log is longer than one package reads, so older entries are not included.`;
}

function memberName(s: Snapshot, id: string): string {
  return s.members.find((m) => m.id === id)?.name ?? id;
}

function placeholder(text: string, columns: number): string[] {
  return [text, ...Array<string>(columns - 1).fill("-")];
}

function formatHours(seconds: number | null | undefined): string {
  return seconds == null ? "-" : (seconds / SECONDS_PER_HOUR).toFixed(1);
}

// The package states every moment in UTC, labelled, as the change log does,
// so a file's name, its upload time and a flight's start agree on the day
// wherever the package is read.
function utcDate(ms: number): string {
  return formatUtc(ms).slice(0, "YYYY-MM-DD".length);
}

// A start time that does not parse is printed as stored rather than lost.
function formatStart(startTime: string): string {
  const ms = Date.parse(startTime);
  return Number.isNaN(ms) ? startTime : formatUtc(ms);
}

function formatUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .slice(0, "YYYY-MM-DDTHH:mm".length)
    .replace("T", " ");
}

function joinLines(parts: string[]): string {
  return parts.filter(Boolean).join("\n") || "-";
}
