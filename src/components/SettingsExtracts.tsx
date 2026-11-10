/**
 * Responsibility: The partial CSV extracts on Settings: some of a Flight
 *   Program's tables, or (System) the deployment's, from this device's
 *   snapshot, each saying plainly that it is not a backup.
 * Layer: UI. React components; the snapshot is already scoped to the user.
 * Dependencies: src/domain (csv, model), ./ProgramUsers (CsvExportCard), ./ui.
 *
 * Work orders, job cards, AD compliance, costs, purchasing and files are not
 * in the extracts: the nightly off-site copy holds everything (ADR-0008), and
 * an aircraft's records package holds its complete record.
 */
import { toCsv } from "../domain/csv";
import { localDate, type Snapshot } from "../domain/model";
import { CsvExportCard } from "./ProgramUsers";
import { download } from "./ui";

const PROGRAM_TABLES = [
  "aircraft",
  "flights",
  "discrepancies",
  "inspections",
  "inspectionTemplates",
  "management",
  "audit",
] as const;
const SYSTEM_TABLES = [
  "aircraft",
  "programs",
  "flights",
  "discrepancies",
  "inspections",
  "inspectionTemplates",
  "management",
  "members",
  "groups",
  "audit",
] as const;
type ExtractTable =
  (typeof PROGRAM_TABLES)[number] | (typeof SYSTEM_TABLES)[number];
const CSV_TYPE = "text/csv;charset=utf-8";
// A file name that says what is in it, where the table key does not.
const CSV_FILE_NAMES: Partial<Record<string, string>> = {
  programs: "flight-programs",
  inspectionTemplates: "inspection-templates",
  management: "components-stock-locations-vendors",
  members: "users",
  groups: "permission-groups",
  audit: "change-log-recent",
};

/**
 * The active Flight Program's partial extract, saved as
 * `<program uuid>-<file>.csv`.
 *
 * @param props.programUuid - The program the snapshot holds.
 */
export function ProgramExtract({
  s,
  programUuid,
}: {
  s: Snapshot;
  programUuid: string;
}) {
  return (
    <div className="set-block set-embed">
      <CsvExportCard
        title="CSV extract (partial)"
        tables={PROGRAM_TABLES}
        fileNames={CSV_FILE_NAMES}
        onDownload={(table) =>
          download(
            `${programUuid}-${csvFileName(table)}.csv`,
            tableCsv(s, table as ExtractTable),
            CSV_TYPE,
          )
        }
      >
        A spreadsheet extract of some of this Flight Program&apos;s tables, from
        this device&apos;s snapshot. {extractLimits(s)} For one aircraft&apos;s
        complete record, export its records package from Change history or the
        aircraft on Overview.
      </CsvExportCard>
    </div>
  );
}

/**
 * The deployment's partial extract for system administrators, saved as
 * `angel-one-<file>-<local date>.csv`.
 */
export function SystemExtract({ s }: { s: Snapshot }) {
  return (
    <div className="set-block set-embed">
      <CsvExportCard
        title="CSV extract (partial)"
        tables={SYSTEM_TABLES}
        fileNames={CSV_FILE_NAMES}
        onDownload={(table) =>
          download(
            `angel-one-${csvFileName(table)}-${localDate()}.csv`,
            tableCsv(s, table as ExtractTable),
            CSV_TYPE,
          )
        }
      >
        A spreadsheet extract of some tables in this device&apos;s snapshot, for
        analysis. {extractLimits(s)} The nightly off-site copies are the
        backups. Pending entries are exported in Sync center.
      </CsvExportCard>
    </div>
  );
}

function csvFileName(table: string) {
  return CSV_FILE_NAMES[table] ?? table;
}

// The snapshot's change log is the newest entries only; the rest is in
// Change history and the backups.
function extractLimits(s: Snapshot) {
  return `It is not a backup: work orders, job cards, AD compliance, costs, purchasing and files are not included, and the change log holds only the ${s.audit.length} newest entries this device has.`;
}

function tableCsv(s: Snapshot, table: ExtractTable) {
  return toCsv((s[table] ?? []).map((row) => ({ ...row })));
}
