/**
 * Responsibility: Assembles one aircraft's records package as a ZIP: loads
 *   the whole change log, prints the tables as records.pdf, writes one CSV
 *   per table, copies the aircraft's stored files within the size limit and
 *   writes the README.
 * Layer: Data. Browser-only: fetches files and the font; no React.
 * Dependencies: fflate, src/data (backend types, tablePdf, pdfFont,
 *   aircraftStatusReport), src/domain (recordsPackage, auditHistory, csv,
 *   model, statusSheet types).
 *
 * The signed logbook entries remain the maintenance record (ADR-0004); this
 * is the on-demand copy for an inspector, buyer or insurer.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import type { Backend } from "./backend";
import { STATUS_COLUMN_SHARES } from "./aircraftStatusReport";
import { loadDejaVuFont } from "./pdfFont";
import { tablePdf, type PageOrientation, type PdfTable } from "./tablePdf";
import { toCsv } from "../domain/csv";
import { MAX_AUDIT_PAGE_SIZE } from "../domain/auditHistory";
import { localDate, type AuditEntry, type Snapshot } from "../domain/model";
import type { StatusSectionId } from "../domain/statusSheet";
import {
  buildRecordsPackage,
  planPackageFiles,
  recordsPackageName,
  recordsReadme,
  type ChangeLogRows,
  type PackageFile,
  type RecordsPackage,
  type RecordsSection,
  type RecordsSectionId,
  type SkippedFile,
} from "../domain/recordsPackage";

/**
 * The most change-log pages read for one package: 400 pages of 100 entries.
 * A log longer than that is copied in part, and the README says so.
 */
export const MAX_CHANGE_LOG_PAGES = 400;

/** Printed in the footer of every page of records.pdf. */
export const RECORDS_PDF_FOOTER =
  "Records copy from Angel One. The signed entries in the aircraft logbooks are the maintenance record (14 CFR 43.9, 43.11).";

const COULD_NOT_DOWNLOAD = "Could not be downloaded";
// Already compressed by their own formats; deflating them again only costs time.
const STORED = { level: 0 } as const;

type Layout = { shares: number[]; orientation: PageOrientation };

const STATUS_LAYOUT = Object.fromEntries(
  Object.entries(STATUS_COLUMN_SHARES).map(([id, shares]) => [
    `status.${id as StatusSectionId}`,
    { shares, orientation: "landscape" },
  ]),
) as Record<`status.${StatusSectionId}`, Layout>;

// Relative column widths and page orientation per table.
const SECTION_LAYOUT: Record<RecordsSectionId, Layout> = {
  ...STATUS_LAYOUT,
  flights: {
    shares: [36, 30, 28, 26, 26, 30, 16, 14, 22, 30, 40],
    orientation: "landscape",
  },
  discrepancies: {
    shares: [26, 26, 70, 16, 50, 16, 26, 26, 50],
    orientation: "landscape",
  },
  workOrders: {
    shares: [24, 18, 18, 18, 16, 40, 24, 36, 110],
    orientation: "landscape",
  },
  adCompliance: {
    shares: [22, 36, 40, 18, 14, 14, 16, 32, 26, 28, 20, 36],
    orientation: "landscape",
  },
  components: {
    shares: [40, 50, 30, 20, 20, 18, 18, 18, 16, 30],
    orientation: "landscape",
  },
  componentRequirements: {
    shares: [40, 32, 50, 14, 34, 34, 34, 24],
    orientation: "landscape",
  },
  form337Copies: { shares: [60, 30, 16, 60, 70], orientation: "portrait" },
  changeLog: { shares: [28, 36, 30, 40, 40, 60, 60], orientation: "landscape" },
};

/** What the export needs and how it reports progress. */
export interface RecordsPackageRequest {
  snapshot: Snapshot;
  aircraftUuid: string;
  /** The backend to page the change log from; null reads the snapshot's. */
  backend: Backend | null;
  /** Called with a short line of progress, such as "Copying files 3 of 12…". */
  onProgress?: (message: string) => void;
  now?: Date;
}

/** The finished package, ready to save. */
export interface RecordsPackageResult {
  /** `<registration>-records-<YYYY-MM-DD>.zip`. */
  name: string;
  blob: Blob;
  /** Files left out, over the size limit or not downloadable; also in README. */
  skipped: SkippedFile[];
}

/**
 * Builds the records package for one aircraft. The change log is paged from
 * the backend until exhausted (or {@link MAX_CHANGE_LOG_PAGES}); without a
 * backend the snapshot's recent entries stand in and the README says the log
 * is partial. Files are fetched one at a time; one that fails to download is
 * skipped and listed in README.txt rather than failing the package.
 *
 * @param request - The snapshot, aircraft, backend and progress callback.
 * @returns The ZIP as a Blob, its name, and the skipped files.
 * @throws {Rejection} "Aircraft not found." when the snapshot lacks the
 *   aircraft; what {@link buildRecordsPackage} throws.
 * @throws {Error} The font loader's "Unable to load the PDF font…", or the
 *   backend's error while paging the change log.
 */
export async function exportRecordsPackage(
  request: RecordsPackageRequest,
): Promise<RecordsPackageResult> {
  const { snapshot, aircraftUuid, now = new Date() } = request;
  const progress = request.onProgress ?? (() => {});
  const today = localDate(now.getTime());
  progress("Loading the change log…");
  const changeLog = await loadChangeLog(request, progress);
  const pkg = buildRecordsPackage(snapshot, aircraftUuid, today, changeLog);
  progress("Printing records.pdf…");
  const pdf = await printTables(pkg, now);
  const plan = planPackageFiles(pkg.files);
  const { copied, skipped } = await copyFiles(plan.included, progress);
  skipped.unshift(...plan.skipped);
  progress("Compressing the package…");
  await yieldToBrowser();
  const readme = recordsReadme(
    pkg,
    { at: `${formatUtc(now)} UTC`, by: snapshot.user.name },
    skipped,
  );
  const zip = zipSync({
    "README.txt": strToU8(readme),
    "records.pdf": [pdf, STORED],
    ...Object.fromEntries(pkg.sections.map((x) => [x.file, strToU8(csv(x))])),
    ...copied,
  });
  return {
    name: recordsPackageName(pkg.aircraft.registration, today),
    blob: new Blob([zip], { type: "application/zip" }),
    skipped,
  };
}

// zipSync holds the main thread, so the progress line is painted first.
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadChangeLog(
  { backend, snapshot, aircraftUuid }: RecordsPackageRequest,
  progress: (message: string) => void,
): Promise<ChangeLogRows> {
  if (!backend)
    return {
      entries: snapshot.audit.filter((a) => a.aircraftUuid === aircraftUuid),
      complete: false,
    };
  const entries: AuditEntry[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_CHANGE_LOG_PAGES; pages++) {
    const result = await backend.auditPage({
      aircraftUuid,
      cursor,
      numItems: MAX_AUDIT_PAGE_SIZE,
    });
    entries.push(...result.page);
    progress(`Loading the change log… ${entries.length} entries`);
    if (result.isDone) return { entries, complete: true };
    cursor = result.continueCursor;
  }
  return { entries, complete: false };
}

async function printTables(
  pkg: RecordsPackage,
  now: Date,
): Promise<Uint8Array> {
  const { aircraft } = pkg;
  const font = await loadDejaVuFont();
  const pdf = tablePdf(pkg.sections.map(toTable), {
    orientation: "landscape",
    header: {
      title: `${aircraft.registration} | AIRCRAFT RECORDS PACKAGE`,
      subtitle: `${aircraft.makeModel} | S/N ${aircraft.serial} | ${aircraft.program}`,
      right: `Generated ${formatUtc(now)} UTC`,
    },
    footer: { note: RECORDS_PDF_FOOTER, label: aircraft.registration },
    font,
  });
  return new Uint8Array(pdf.output("arraybuffer"));
}

function toTable(section: RecordsSection): PdfTable {
  return { ...section, ...SECTION_LAYOUT[section.id] };
}

// A printed "-" stands for an empty cell; in a CSV the cell is empty (toCsv
// would otherwise quote the dash as text, since it can start a formula).
function csv(section: RecordsSection): string {
  const cell = (value: string | undefined) =>
    value === undefined || value === "-" ? "" : value;
  return toCsv(
    section.rows.map((row) =>
      Object.fromEntries(section.columns.map((c, i) => [c, cell(row[i])])),
    ),
  );
}

async function copyFiles(
  files: PackageFile[],
  progress: (message: string) => void,
): Promise<{ copied: Zippable; skipped: SkippedFile[] }> {
  const copied: Zippable = {};
  const skipped: SkippedFile[] = [];
  for (const [index, file] of files.entries()) {
    progress(`Copying files ${index + 1} of ${files.length}…`);
    try {
      copied[file.path] = [await fileBytes(file.url), STORED];
    } catch {
      // A file that cannot be fetched (expired URL, network) is reported in
      // README.txt; the rest of the package is still worth having.
      skipped.push({ file, reason: COULD_NOT_DOWNLOAD });
    }
  }
  return { copied, skipped };
}

// Demo files are data: URLs, which the Content-Security-Policy keeps fetch()
// from reading, so those are decoded here.
async function fileBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) return dataUrlBytes(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const header = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  if (header.endsWith(";base64"))
    return Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  return strToU8(decodeURIComponent(payload));
}

function formatUtc(date: Date): string {
  return date
    .toISOString()
    .slice(0, "YYYY-MM-DDTHH:mm".length)
    .replace("T", " ");
}
