/**
 * Responsibility: The inspection template library: reusable requirement
 *   intervals and task instructions, saved per Flight Program, and built from
 *   manual candidates or CSV files.
 * Layer: Domain. Zod schemas and an applier; no I/O, no React.
 * Dependencies: zod, ./model, ./programs, ./manuals, ./manualDiscovery,
 *   ./maintenanceCsv, ./rejection, ./changeLog.
 *
 * A template holds intervals only, never compliance (last done, next due):
 * those belong to the aircraft records made when a template is activated.
 */
import { z } from "zod";
import type { Snapshot } from "./model";
import { activeProgram, ownsActive, programPermission } from "./programs";
import {
  manualApplicabilitySchema,
  manualReferenceSchema,
  validateManualReference,
  type ManualApplicability,
} from "./manuals";
import type { ManualCandidate } from "./manualDiscovery";
import { readCsvRows, type ImportedTask } from "./maintenanceCsv";
import { Rejection, StaleRecordRejection } from "./rejection";
import { auditEntry } from "./changeLog";

const INTERVAL_MAX = 1000000;

// A template is stored whole in one Convex document, which Convex caps at
// 1 MiB.
const TEMPLATE_MAX_BYTES = 800000;
const SAVE_MAX_BYTES = 2 * 1024 * 1024;

/** Longest template name. */
export const TEMPLATE_NAME_MAX_LENGTH = 200;
/** Longest inspection group, the heading templates are listed under. */
export const TEMPLATE_GROUP_MAX_LENGTH = 150;
/** Longest template description. */
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 10000;
/** Longest conditions or applicability note. */
export const TEMPLATE_CONDITIONS_MAX_LENGTH = 2000;
/** Largest template CSV file the import reads: the shared CSV limit. */
export { CSV_MAX_BYTES as TEMPLATE_CSV_MAX_BYTES } from "./maintenanceCsv";

const LIMIT_MODES = ["ABSOLUTE", "FROM_LAST_COMPLIED"] as const;
const CALENDAR_UNITS = ["DAYS", "MONTHS", "YEARS"] as const;
const TIME_BASES = ["TSN", "TSO", "TSR"] as const;
const REQUIREMENT_TYPES = [
  "Inspection Requirement",
  "Overhaul Requirement",
  "Life Limits",
] as const;

// Any one of these schedules a template; without them it needs conditions.
const SCHEDULE_FIELDS = [
  "hours",
  "cycles",
  "landings",
  "initialLandings",
  "calendarValue",
  "initialHours",
  "initialCycles",
] as const;

// A template CSV row with a description but no conditions and none of these
// columns is narrative only (an event or bulletin): its description becomes
// its conditions and no interval is inferred. Landing columns are not among
// them, so a row with only landings copies its description too.
const CSV_SCHEDULE_COLUMNS = [
  "hours",
  "cycles",
  "calendar_value",
  "initial_hours",
  "initial_cycles",
];

// A maintenance status report (columns such as "DATE DUE" and "SVC LIFE
// MONTHS") is read for its service-life intervals only; its due dates and
// compliance are ignored.
const STATUS_REPORT_NAME = "INSPECTION / COMPONENT";
const STATUS_REPORT_HOURS = "SVC LIFE HRS/LAND";
const STATUS_REPORT_NOTE_COLUMNS = [
  "Part Number/Notes",
  "Serial Number/Notes",
  "SVC life Corrosion Insp Progm",
];

// Rows whose conditions say they do not apply ("NOT USED", "N/A") import
// unselected.
const NOT_APPLICABLE = /not used|not installed|\bna\b|n\/a/i;

const count = z.number().int().positive().max(INTERVAL_MAX);
const hours = z
  .number()
  .positive()
  .max(INTERVAL_MAX)
  .refine((n) => Number.isInteger(n * 10), "Use tenths of an hour.");

const INSTRUCTION_MAX_LENGTH = 9000;
const INSTRUCTION_REQUIRED = `Enter a task instruction of up to ${INSTRUCTION_MAX_LENGTH.toLocaleString("en-US")} characters.`;
const PDF_PAGE_MAX = 100000;
const PDF_PAGE_RANGE = `PDF page must be a positive whole number up to ${PDF_PAGE_MAX.toLocaleString("en-US")}.`;

/**
 * One task instruction in a template, copied to a task card when the template
 * is activated. Its messages name the task CSV columns.
 *
 * @throws {z.ZodError} From `parse()`: "Enter a task instruction of up to
 *   9,000 characters."; "<Item code | Applicability | Zone | Manual
 *   reference> is too long (up to 100 | 1,000 characters)."; "PDF page must
 *   be a positive whole number up to 100,000."; or an unknown field.
 */
export const templateTaskSchema = z.strictObject({
  itemCode: taskText("Item code", 100),
  instruction: z
    .string()
    .trim()
    .min(1, INSTRUCTION_REQUIRED)
    .max(INSTRUCTION_MAX_LENGTH, INSTRUCTION_REQUIRED),
  applicability: taskText("Applicability", 1000),
  manualReference: manualReferenceSchema.optional(),
  zone: taskText("Zone", 1000).optional(),
  referenceText: taskText("Manual reference", 1000).optional(),
  pdfPage: z
    .number()
    .int(PDF_PAGE_RANGE)
    .positive(PDF_PAGE_RANGE)
    .max(PDF_PAGE_MAX, PDF_PAGE_RANGE)
    .optional(),
});

/** A parsed template task. */
export type TemplateTask = z.infer<typeof templateTaskSchema>;

/**
 * Says where a template task's instruction comes from, for its task card.
 *
 * @param t - The template task.
 * @returns Its reference text, then "PDF page N", joined with " · "; empty
 *   parts skipped.
 */
export function taskSourceText(t: TemplateTask) {
  return [
    t.referenceText,
    t.pdfPage !== undefined ? `PDF page ${t.pdfPage}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Says what a template task applies to, for its task card.
 *
 * @param t - The template task.
 * @returns Its applicability, then "Zone: <zone>", joined with "\n"; empty
 *   parts skipped.
 */
export function taskApplicabilityText(t: TemplateTask) {
  return [t.applicability, t.zone ? `Zone: ${t.zone}` : ""]
    .filter(Boolean)
    .join("\n");
}

/**
 * A reusable requirement for an aircraft or component type: intervals,
 * initial thresholds, conditions and tasks. Unknown fields, such as an
 * aircraft or a compliance date, are refused.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field, hours not in tenths
 *   ("Use tenths of an hour."), or no interval, threshold or conditions
 *   ("Enter an interval, initial threshold, or conditions describing the
 *   requirement.").
 */
export const inspectionTemplateSchema = z
  .strictObject({
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    programUuid: z.string().optional(),
    sourceKey: z.string().max(300).optional(),
    name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX_LENGTH),
    group: z.string().trim().max(TEMPLATE_GROUP_MAX_LENGTH),
    applicability: manualApplicabilitySchema,
    description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX_LENGTH),
    conditions: z.string().trim().max(TEMPLATE_CONDITIONS_MAX_LENGTH),
    requirementType: z.enum(REQUIREMENT_TYPES),
    hours: hours.optional(),
    cycles: count.optional(),
    landings: count.optional(),
    initialLandings: count.optional(),
    landingMode: z.enum(LIMIT_MODES).optional(),
    calendarValue: count.optional(),
    calendarUnit: z.enum(CALENDAR_UNITS),
    initialHours: hours.optional(),
    initialCycles: count.optional(),
    timeBasis: z.enum(TIME_BASES),
    hourMode: z.enum(LIMIT_MODES),
    cycleMode: z.enum(LIMIT_MODES),
    manualReference: manualReferenceSchema.optional(),
    archived: z.boolean(),
    tasks: z.array(templateTaskSchema).max(2000),
  })
  .refine(
    (t) =>
      SCHEDULE_FIELDS.some((field) => t[field] !== undefined) || !!t.conditions,
    "Enter an interval, initial threshold, or conditions describing the requirement.",
  );

/** A parsed inspection template. */
export type InspectionTemplate = z.infer<typeof inspectionTemplateSchema>;

/**
 * Starts a new template: a fresh uuid at version 0, aircraft applicability,
 * months, TSN and intervals counted from the last compliance.
 *
 * @returns A template that fails the schema until it has a name and an
 *   interval, threshold or conditions.
 */
export function emptyTemplate(): InspectionTemplate {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    name: "",
    group: "",
    applicability: {
      kind: "aircraft",
      manufacturer: "",
      model: "",
      partNumber: "",
    },
    description: "",
    conditions: "",
    requirementType: "Inspection Requirement",
    calendarUnit: "MONTHS",
    timeBasis: "TSN",
    hourMode: "FROM_LAST_COMPLIED",
    cycleMode: "FROM_LAST_COMPLIED",
    archived: false,
    tasks: [],
  };
}

/**
 * Identifies a template by what it names, so a library holds each one once.
 *
 * @param t - The template.
 * @returns A JSON array of its applicability kind, manufacturer, model, part
 *   number, group and name, each trimmed, lower-cased and with runs of
 *   whitespace collapsed to one space.
 */
export function templateIdentity(t: InspectionTemplate) {
  return JSON.stringify(
    [
      t.applicability.kind,
      t.applicability.manufacturer,
      t.applicability.model,
      t.applicability.partNumber,
      t.group,
      t.name,
    ].map(normalizeIdentityPart),
  );
}

/**
 * Saves templates into the active Flight Program's library, all or none, each
 * at the next version with an "inspectionTemplate.save" audit entry prepended.
 *
 * @param s - Working snapshot; its templates and audit change.
 * @param raw - 1 to 2,000 templates, each at the version it was opened at.
 * @returns Per template, in order: `before` (undefined when new) and `next`.
 * @throws {Rejection} Without maintenance permission; over 2 MB, or 800 KB for
 *   one template; another program's template; a stale version ("Template
 *   changed. Reopen it before saving."); a duplicate name or manual source.
 * @throws {Error} A repeated uuid or unavailable manual; {z.ZodError} a bad
 *   template.
 */
export function saveInspectionTemplates(
  s: Snapshot,
  raw: InspectionTemplate[],
) {
  if (!programPermission(s, "maintenance"))
    throw new Rejection(
      "Maintenance permission is required to save templates.",
    );
  const parsed = parseTemplateBatch(raw);
  const records = [...(s.inspectionTemplates ?? [])];
  const results = parsed.map((input) => {
    const before = records.find((t) => t.uuid === input.uuid);
    assertTemplateSavable(s, records, input, before);
    const next = {
      ...input,
      programUuid: activeProgram(s),
      version: input.version + 1,
    };
    upsertTemplate(records, next);
    return { before, next };
  });
  s.inspectionTemplates = records;
  for (const { before, next } of results)
    s.audit.unshift(
      auditEntry(s, {
        action: "inspectionTemplate.save",
        entityUuid: next.uuid,
        before,
        after: next,
      }),
    );
  return results;
}

/**
 * Drafts a template from a requirement found in a manual, with the tasks the
 * manual lists under it.
 *
 * @param row - The manual candidate.
 * @param scope - The manual's applicability. A component candidate keeps its
 *   own manufacturer, model and part number, falling back to a component
 *   scope's.
 * @param tasks - Imported tasks; only those whose parent is this candidate
 *   are kept.
 * @returns An unsaved template (version 0, new uuid); it is not validated.
 */
export function templateFromCandidate(
  row: ManualCandidate,
  scope: ManualApplicability,
  tasks: ImportedTask[] = [],
): InspectionTemplate {
  const requirement = row.requirementDefaults;
  return {
    ...emptyTemplate(),
    name: row.name,
    applicability: deriveCandidateApplicability(row, scope),
    description: row.text,
    conditions: row.scheduleText,
    hours: row.hours,
    cycles: row.cycles,
    calendarValue: requirement?.calendarIntervalValue ?? row.months,
    calendarUnit: requirement?.calendarIntervalUnit ?? "MONTHS",
    initialHours: row.initialHours,
    initialCycles: row.initialCycles,
    requirementType: requirement?.requirementType ?? "Inspection Requirement",
    timeBasis: requirement?.timeBasis ?? "TSN",
    hourMode: requirement?.timeLimitMode ?? "FROM_LAST_COMPLIED",
    cycleMode: requirement?.cycleLimitMode ?? "FROM_LAST_COMPLIED",
    sourceKey: row.sourceKey,
    manualReference: row.reference,
    tasks: selectCandidateTasks(row, tasks),
  };
}

/** Required columns of a template CSV, in the order the download offers. */
export const templateCsvHeaders = [
  "name",
  "description",
  "hours",
  "cycles",
  "calendar_value",
  "calendar_unit",
  "initial_hours",
  "initial_cycles",
  "conditions",
  "requirement_type",
  "time_basis",
  "hour_mode",
  "cycle_mode",
];

/** Optional landing columns a template CSV may add. */
export const templateLandingCsvHeaders = [
  "landings",
  "initial_landings",
  "landing_mode",
];

/**
 * Reads a template CSV, or a maintenance status report, into templates to
 * review before saving. Choice columns match case-insensitively; blank ones
 * take the {@link emptyTemplate} defaults.
 *
 * @param text - The CSV file's text.
 * @param scope - Applicability given to every template.
 * @param group - Group given to every template.
 * @returns Per record, in file order: its CSV `row`, then the `template` or a
 *   readable `error`; `selected` is false for errors and rows not applicable.
 * @throws {Rejection} When the file has no records or repeats a column name,
 *   or a template CSV lacks a required column or has an unknown one.
 */
export function parseTemplateCsv(
  text: string,
  scope: ManualApplicability,
  group: string,
) {
  const [rawHeader, ...rows] = readCsvRows(text);
  const header = rawHeader?.cells.map((h) => h.trim());
  if (!header || !rows.length)
    throw new Rejection("Choose a CSV with headers and records.");
  const namedHeaders = header.filter(Boolean);
  if (new Set(namedHeaders).size !== namedHeaders.length)
    throw new Rejection("Duplicate CSV column names are not supported.");
  const statusReport =
    header.includes(STATUS_REPORT_NAME) && header.includes(STATUS_REPORT_HOURS);
  if (!statusReport && !hasTemplateCsvColumns(header))
    throw new Rejection(
      `Use the template CSV columns: ${templateCsvHeaders.join(", ")}`,
    );
  const csv = { header, statusReport, scope, group };
  return rows.map(({ cells, row }) => parseTemplateRow(csv, cells, row));
}

interface TemplateCsv {
  header: string[];
  statusReport: boolean;
  scope: ManualApplicability;
  group: string;
}

interface CsvRowReader {
  text(column: string): string;
  number(column: string): number | undefined;
  choice(column: string, choices: readonly string[], fallback: string): string;
}

function normalizeIdentityPart(part: string) {
  return part.trim().replace(/\s+/g, " ").toLowerCase();
}

function measureJsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function parseTemplateBatch(raw: InspectionTemplate[]) {
  const parsed = z.array(inspectionTemplateSchema).min(1).max(2000).parse(raw);
  if (new Set(parsed.map((t) => t.uuid)).size !== parsed.length)
    throw new Error("Duplicate template IDs in this batch.");
  if (measureJsonBytes(parsed) > SAVE_MAX_BYTES)
    throw new Rejection("Save templates in batches up to 2 MB.");
  if (parsed.some((t) => measureJsonBytes(t) > TEMPLATE_MAX_BYTES))
    throw new Rejection(
      "A template with its tasks must fit within 800 KB. Split the checklist into smaller templates.",
    );
  return parsed;
}

function assertTemplateSavable(
  s: Snapshot,
  records: InspectionTemplate[],
  input: InspectionTemplate,
  before: InspectionTemplate | undefined,
) {
  if (
    (before && !ownsActive(s, before.programUuid)) ||
    (input.programUuid !== undefined && !ownsActive(s, input.programUuid))
  )
    throw new Rejection("Template belongs to another Flight Program.");
  if (input.version !== (before?.version ?? 0))
    throw new StaleRecordRejection("inspectionTemplate", before?.version ?? 0);
  validateManualReference(s, input.manualReference);
  input.tasks.forEach((t) => validateManualReference(s, t.manualReference));
  if (records.some((saved) => isDuplicateTemplate(s, saved, input)))
    throw new Rejection(
      `Template already exists: ${input.name}. Edit the saved template instead.`,
    );
}

// Earlier templates in the same batch are already in `records`, so a batch
// cannot hold two copies of one template either.
function isDuplicateTemplate(
  s: Snapshot,
  saved: InspectionTemplate,
  input: InspectionTemplate,
) {
  if (saved.uuid === input.uuid || !ownsActive(s, saved.programUuid))
    return false;
  if (templateIdentity(saved) === templateIdentity(input)) return true;
  return (
    !!input.sourceKey &&
    saved.sourceKey === input.sourceKey &&
    JSON.stringify(saved.applicability) === JSON.stringify(input.applicability)
  );
}

function upsertTemplate(
  records: InspectionTemplate[],
  next: InspectionTemplate,
) {
  const index = records.findIndex((t) => t.uuid === next.uuid);
  if (index < 0) records.push(next);
  else records[index] = next;
}

function deriveCandidateApplicability(
  row: ManualCandidate,
  scope: ManualApplicability,
): ManualApplicability {
  if (row.kind !== "component") return scope;
  const defaults = row.componentDefaults;
  const component = scope.kind === "component" ? scope : undefined;
  return {
    kind: "component",
    manufacturer: defaults?.manufacturer || component?.manufacturer || "",
    model: defaults?.model || component?.model || "",
    partNumber: defaults?.partNumber || component?.partNumber || "",
  };
}

function selectCandidateTasks(row: ManualCandidate, tasks: ImportedTask[]) {
  const parentType =
    row.kind === "inspection" ? "inspection" : "component_requirement";
  return tasks
    .filter((t) => t.parentId === row.importId && t.parentType === parentType)
    .map((t) => ({
      itemCode: t.itemCode,
      instruction: t.instruction,
      applicability: t.applicability,
      manualReference: t.reference,
    }));
}

function hasTemplateCsvColumns(header: string[]) {
  const known = [...templateCsvHeaders, ...templateLandingCsvHeaders];
  return (
    header.every((h) => known.includes(h)) &&
    templateCsvHeaders.every((h) => header.includes(h))
  );
}

function parseTemplateRow(csv: TemplateCsv, cells: string[], row: number) {
  try {
    if (cells.length !== csv.header.length)
      throw new Rejection("Column count does not match the header.");
    const read = createRowReader(csv.header, cells);
    const fields = csv.statusReport
      ? readStatusReportRow(read)
      : readTemplateCsvRow(read);
    const template = inspectionTemplateSchema.parse({
      ...emptyTemplate(),
      applicability: csv.scope,
      group: csv.group,
      ...fields,
    });
    const selected = !NOT_APPLICABLE.test(fields.conditions);
    return { row, template, error: "", selected };
  } catch (e) {
    return {
      row,
      template: undefined,
      error: describeRowError(e),
      selected: false,
    };
  }
}

// Every field is set, even to undefined, so the parsed template has the same
// keys whichever format the row came from.
function readTemplateCsvRow(read: CsvRowReader) {
  const description = read.text("description");
  const unscheduled = CSV_SCHEDULE_COLUMNS.every((h) => !read.text(h));
  return {
    name: read.text("name"),
    description,
    conditions:
      read.text("conditions") ||
      (description && unscheduled ? description : ""),
    hours: read.number("hours"),
    cycles: read.number("cycles"),
    landings: read.number("landings"),
    initialLandings: read.number("initial_landings"),
    landingMode: read.choice("landing_mode", LIMIT_MODES, "FROM_LAST_COMPLIED"),
    calendarValue: read.number("calendar_value"),
    calendarUnit: read.choice("calendar_unit", CALENDAR_UNITS, "MONTHS"),
    initialHours: read.number("initial_hours"),
    initialCycles: read.number("initial_cycles"),
    requirementType: read.choice(
      "requirement_type",
      REQUIREMENT_TYPES,
      "Inspection Requirement",
    ),
    timeBasis: read.choice("time_basis", TIME_BASES, "TSN"),
    hourMode: read.choice("hour_mode", LIMIT_MODES, "FROM_LAST_COMPLIED"),
    cycleMode: read.choice("cycle_mode", LIMIT_MODES, "FROM_LAST_COMPLIED"),
  };
}

function readStatusReportRow(read: CsvRowReader) {
  return {
    name: read.text(STATUS_REPORT_NAME),
    description: "",
    conditions: STATUS_REPORT_NOTE_COLUMNS.map((h) => read.text(h))
      .filter(Boolean)
      .join("; "),
    hours: read.number(STATUS_REPORT_HOURS),
    cycles: undefined,
    landings: undefined,
    initialLandings: undefined,
    landingMode: read.choice("landing_mode", LIMIT_MODES, "FROM_LAST_COMPLIED"),
    calendarValue: read.number("SVC LIFE MONTHS"),
    calendarUnit: "MONTHS",
    initialHours: undefined,
    initialCycles: undefined,
    requirementType: "Inspection Requirement",
    timeBasis: "TSN",
    hourMode: "FROM_LAST_COMPLIED",
    cycleMode: "FROM_LAST_COMPLIED",
  };
}

function createRowReader(header: string[], cells: string[]): CsvRowReader {
  const text = (column: string) => (cells[header.indexOf(column)] ?? "").trim();
  return {
    text,
    number: (column) => readNumber(column, text(column)),
    choice: (column, choices, fallback) => {
      const value = text(column);
      const match = choices.find(
        (choice) => choice.toLowerCase() === value.toLowerCase(),
      );
      return match ?? (value || fallback);
    },
  };
}

function readNumber(column: string, value: string) {
  if (!value) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Rejection(`Invalid number in ${column}.`);
  return Number(value);
}

function describeRowError(e: unknown) {
  if (e instanceof z.ZodError)
    return e.issues
      .map(
        (issue) => `${issue.path.join(".") || "Requirement"}: ${issue.message}`,
      )
      .join("; ");
  return e instanceof Error ? e.message : "Invalid row";
}

// Text a template task may leave blank; past its limit the message names the
// field as the task CSV's column does.
function taskText(label: string, maxLength: number) {
  return z
    .string()
    .max(
      maxLength,
      `${label} is too long (up to ${maxLength.toLocaleString("en-US")} characters).`,
    );
}
