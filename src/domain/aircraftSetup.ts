/**
 * Responsibility: Aircraft setup (GLOSSARY): the CSV templates that load an
 *   aircraft's inspection and AD history, the dry-run plan that turns them
 *   into commands, and which setup steps still lack data.
 * Layer: Domain. Pure parsing and planning; no I/O, no React.
 * Dependencies: zod, ./maintenanceCsv, ./model, ./management/schemas,
 *   ./airworthiness, ./componentTemplates, ./readings, ./validationText,
 *   ./rejection.
 *
 * The plan builds the same commands the Inspections and Airworthiness screens
 * send, so the appliers keep every rule; the plan only predicts the refusals a
 * person can fix in the file before anything is saved.
 */
import { z, ZodError } from "zod";
import { readCsvRows } from "./maintenanceCsv";
import {
  recordedTotalSeconds,
  latestLocalDate,
  localDate,
  type Aircraft,
  type Snapshot,
} from "./model";
import type { ManagementCommand } from "./management/schemas";
import {
  adNumber,
  blankAD,
  type ADCommand,
  type ADTask,
} from "./airworthiness";
import { pendingComponentSetups } from "./componentTemplates";
import { parseHours, SECONDS_PER_HOUR } from "./readings";
import { validationText } from "./validationText";
import { Rejection } from "./rejection";

/** The steps of the setup wizard, in order. */
export const SETUP_STEPS = [
  "aircraft",
  "components",
  "inspections",
  "ads",
  "review",
  "commit",
] as const;

/** One wizard step. */
export type SetupStep = (typeof SETUP_STEPS)[number];

/** A setup step that can still lack data once the aircraft exists. */
export type SetupGap = "baseline" | "components" | "inspections" | "ads";

/** The Fleet page's chip text for each gap, and the step that fills it. */
export const SETUP_GAPS: Record<SetupGap, { label: string; step: SetupStep }> =
  {
    baseline: { label: "Baseline readings missing", step: "aircraft" },
    components: { label: "Components missing", step: "components" },
    inspections: { label: "Inspections missing", step: "inspections" },
    ads: { label: "ADs not reviewed", step: "ads" },
  };

/** The inspection template's columns, in order; every one is required. */
export const inspectionSetupHeaders = [
  "name",
  "interval_hours",
  "interval_months",
  "interval_cycles",
  "interval_landings",
  "last_done_date",
  "last_done_hours",
  "last_done_cycles",
  "last_done_landings",
  "notes",
] as const;

/** The AD compliance template's columns, in order; every one is required. */
export const adSetupHeaders = [
  "ad_number",
  "title",
  "applies",
  "compliance_date",
  "compliance_hours",
  "method",
  "next_due_hours",
  "next_due_date",
  "recurring",
  "notes",
] as const;

/** One inspection read from the template; times are seconds. */
export interface InspectionSetupRow {
  /** The 1-based spreadsheet row, for messages. */
  row: number;
  name: string;
  intervalSeconds?: number;
  intervalMonths?: number;
  intervalCycles?: number;
  intervalLandings?: number;
  lastDate?: string;
  lastSeconds?: number;
  lastCycles?: number;
  lastLandings?: number;
  notes: string;
}

/** One AD read from the template; hours are decimal, as AD records keep them. */
export interface AdSetupRow {
  /** The 1-based spreadsheet row, for messages. */
  row: number;
  number: string;
  title: string;
  applies: boolean;
  complianceDate?: string;
  complianceHours?: number;
  method: string;
  nextDueHours?: number;
  nextDueDate?: string;
  /** Undefined when the file leaves recurrence blank. */
  recurring?: boolean;
  notes: string;
}

/** The rows of both templates, as the wizard holds them. */
export interface ParsedSetup {
  inspections: InspectionSetupRow[];
  ads: AdSetupRow[];
}

/**
 * One command the commit step will send: the row it came from (`key`,
 * `label`), what it saves in a phrase (`detail`), and the command.
 */
export type SetupAction =
  | {
      step: "inspections";
      key: string;
      label: string;
      detail: string;
      command: ManagementCommand;
    }
  | {
      step: "ads";
      key: string;
      label: string;
      detail: string;
      command: ADCommand;
    };

/**
 * What the wizard keeps in this browser between visits: both template texts
 * and the rows a commit has already saved.
 *
 * @throws {z.ZodError} From `parse()` on a stored draft of another shape.
 */
export const setupDraftSchema = z.object({
  inspectionCsv: z.string(),
  adCsv: z.string(),
  done: z.array(z.string()),
});

/** A parsed {@link setupDraftSchema} draft. */
export type SetupDraft = z.infer<typeof setupDraftSchema>;

/** A row the commit will not send, and why. */
export interface SkippedRow {
  step: "inspections" | "ads";
  key: string;
  label: string;
  reason: string;
}

/**
 * The dry run: what the commit will save, what it will skip, what a person
 * should look at, and what must be fixed in the file first.
 */
export interface SetupPlan {
  actions: SetupAction[];
  skipped: SkippedRow[];
  warnings: string[];
  errors: string[];
}

/** Which setup steps hold data for an aircraft. */
export interface SetupStatus {
  /** Total time is above zero. */
  baseline: boolean;
  /** At least one component is installed. */
  components: boolean;
  /** At least one active inspection schedule exists. */
  inspections: boolean;
  /** At least one AD has its applicability decided. */
  ads: boolean;
  /** "Setup incomplete" components still waiting for serials and readings. */
  pendingComponents: number;
  /** The gaps, in step order; empty once setup is complete. */
  gaps: SetupGap[];
}

/** Written into the change log by every inspection the setup saves. */
export const SETUP_INSPECTION_REASON =
  "Aircraft setup: inspection loaded from the setup template.";
/** Written into the change log by every AD the setup marks not applicable. */
export const SETUP_NOT_APPLICABLE_REASON =
  "Recorded as not applicable during aircraft setup.";
/** The AD source name the setup template records. */
export const SETUP_AD_SOURCE = "Aircraft setup";

const TEXT_MAX_LENGTH = 2000;
const AD_NUMBER_MAX_LENGTH = 100;
const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

const text = z.string().trim().max(TEXT_MAX_LENGTH);
const requiredText = text.min(1);
const wholeCount = z.number().int().nonnegative();
const positiveCount = wholeCount.positive();
const isoDate = z.iso.date();

const inspectionRowSchema = z.object({
  row: z.number().int().positive(),
  name: requiredText,
  intervalSeconds: positiveCount.optional(),
  intervalMonths: positiveCount.optional(),
  intervalCycles: positiveCount.optional(),
  intervalLandings: positiveCount.optional(),
  lastDate: isoDate.optional(),
  lastSeconds: wholeCount.optional(),
  lastCycles: wholeCount.optional(),
  lastLandings: wholeCount.optional(),
  notes: text,
});

const adRowSchema = z.object({
  row: z.number().int().positive(),
  number: z.string().trim().min(1).max(AD_NUMBER_MAX_LENGTH),
  title: text,
  applies: z.boolean(),
  complianceDate: isoDate.optional(),
  complianceHours: z.number().finite().nonnegative().optional(),
  method: text,
  nextDueHours: z.number().finite().nonnegative().optional(),
  nextDueDate: isoDate.optional(),
  recurring: z.boolean().optional(),
  notes: text,
});

/**
 * Reads the inspection template. Column names match ignoring case, spaces
 * and hyphens, in any order; blank cells mean unknown.
 *
 * @param csv - The file's text; a leading byte-order mark is ignored.
 * @returns The rows in file order; the header row alone gives [].
 * @throws {Rejection} "Use columns: …" for other headers; the
 *   {@link readCsvRows} limits (2 MB, 2,000 rows); or "Row <n>: <reason>" for
 *   a blank name, an interval or count that is not a positive whole number,
 *   hours that are not in tenths, or a date that is not YYYY-MM-DD.
 */
export function parseInspectionSetupCsv(csv: string): InspectionSetupRow[] {
  return readTemplate(csv, inspectionSetupHeaders, (get, row) =>
    inspectionRowSchema.parse({
      row,
      name: get("name"),
      intervalSeconds: parseHours(get("interval_hours")),
      intervalMonths: readCount(get("interval_months")),
      intervalCycles: readCount(get("interval_cycles")),
      intervalLandings: readCount(get("interval_landings")),
      lastDate: get("last_done_date") || undefined,
      lastSeconds: parseHours(get("last_done_hours")),
      lastCycles: readCount(get("last_done_cycles")),
      lastLandings: readCount(get("last_done_landings")),
      notes: get("notes"),
    }),
  );
}

/**
 * Reads the AD compliance template, as {@link parseInspectionSetupCsv} reads
 * its file. `applies` must be yes or no; `recurring` may be blank.
 *
 * @param csv - The file's text.
 * @returns The rows in file order.
 * @throws {Rejection} As {@link parseInspectionSetupCsv}; "Row <n>: applies
 *   must be yes or no." or "Row <n>: recurring must be yes, no or blank.".
 */
export function parseAdSetupCsv(csv: string): AdSetupRow[] {
  return readTemplate(csv, adSetupHeaders, (get, row) =>
    adRowSchema.parse({
      row,
      number: get("ad_number"),
      title: get("title"),
      applies: readYesNo(get("applies"), "applies") ?? false,
      complianceDate: get("compliance_date") || undefined,
      complianceHours: readDecimal(get("compliance_hours")),
      method: get("method"),
      nextDueHours: readDecimal(get("next_due_hours")),
      nextDueDate: get("next_due_date") || undefined,
      recurring: readYesNo(get("recurring"), "recurring", true),
      notes: get("notes"),
    }),
  );
}

/**
 * Plans the commit: one `inspection.save` per inspection row and one AD
 * `save` per AD row, each with its own request id. Nothing is saved; the
 * wizard sends the actions in order on commit.
 *
 * An AD that applies and has a compliance date is saved as Previously
 * Complied With (PCW), with its date and hours as prior compliance; one that
 * applies without a date is Applicable; one that does not apply is Not
 * applicable with {@link SETUP_NOT_APPLICABLE_REASON}. A next due limit or a
 * recurring answer adds one required action carrying them.
 *
 * @param s - The aircraft and its records.
 * @param aircraftUuid - The aircraft being set up.
 * @param parsed - The template rows.
 * @param options.done - Row keys already saved by this setup; they are
 *   skipped, so a resumed commit sends only what is left.
 * @param options.now - The clock, for future-date checks.
 * @returns The plan. `errors` names rows the appliers would refuse (an
 *   interval without its last-done value, last-done above current totals, a
 *   future date, a duplicate within the file); `warnings` names what is saved
 *   but worth a look (missing baseline, limits already passed, an AD with no
 *   due limit); `skipped` lists rows already on record or already saved.
 */
export function planAircraftSetup(
  s: Snapshot,
  aircraftUuid: string,
  parsed: ParsedSetup,
  options: { done?: readonly string[]; now?: number } = {},
): SetupPlan {
  const plan: SetupPlan = {
    actions: [],
    skipped: [],
    warnings: [],
    errors: [],
  };
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!aircraft) {
    plan.errors.push("Aircraft not found.");
    return plan;
  }
  const ctx: PlanContext = {
    s,
    aircraft,
    totalSeconds: recordedTotalSeconds(aircraft),
    today: latestLocalDate(options.now),
    localToday: localDate(options.now),
    done: new Set(options.done ?? []),
    plan,
  };
  if (!ctx.totalSeconds)
    plan.warnings.push(
      "Aircraft total time is 0.0 h. Enter the baseline readings in the Aircraft step before loading history.",
    );
  planInspections(ctx, parsed.inspections);
  planAds(ctx, parsed.ads);
  return plan;
}

/**
 * Which setup steps hold data for an aircraft, for the Fleet page's chips
 * and the wizard's progress.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft.
 * @returns The status; for an unknown aircraft every step is a gap.
 */
export function setupStatus(s: Snapshot, aircraftUuid: string): SetupStatus {
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  const flags = {
    baseline: !!aircraft && (recordedTotalSeconds(aircraft) ?? 0) > 0,
    components: (s.management ?? []).some(
      (r) =>
        r.kind === "component" &&
        r.installed &&
        r.aircraftUuid === aircraftUuid,
    ),
    inspections: s.inspections.some(
      (i) => i.aircraftUuid === aircraftUuid && !i.archived,
    ),
    ads: (s.airworthiness ?? []).some(
      (r) =>
        r.aircraftUuid === aircraftUuid && r.applicability !== "Needs review",
    ),
  };
  return {
    ...flags,
    pendingComponents: pendingComponentSetups(s).filter(
      (d) => d.aircraftUuid === aircraftUuid,
    ).length,
    gaps: (Object.keys(SETUP_GAPS) as SetupGap[]).filter((g) => !flags[g]),
  };
}

/**
 * The step key the wizard opens from a URL.
 *
 * @param value - The `step` search parameter.
 * @returns The step, or undefined for anything else.
 */
export function readSetupStep(value: unknown): SetupStep | undefined {
  return SETUP_STEPS.find((step) => step === value);
}

interface PlanContext {
  s: Snapshot;
  aircraft: Aircraft;
  totalSeconds: number | undefined;
  today: string;
  localToday: string;
  done: Set<string>;
  plan: SetupPlan;
}

type CellReader = (header: string) => string;

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

function readTemplate<T>(
  csv: string,
  headers: readonly string[],
  readRow: (get: CellReader, row: number) => T,
): T[] {
  const [header, ...data] = readCsvRows(csv);
  const columns = (header?.cells ?? []).map(norm);
  const known = headers.map(norm);
  if (
    new Set(columns).size !== columns.length ||
    known.some((h) => !columns.includes(h)) ||
    columns.some((h) => !known.includes(h))
  )
    throw new Rejection(`Use columns: ${headers.join(", ")}.`);
  return data.map(({ cells, row }) => {
    if (cells.length !== columns.length)
      throw new Rejection(`Row ${row}: column count does not match header.`);
    const get: CellReader = (h) =>
      (cells[columns.indexOf(norm(h))] ?? "").trim();
    try {
      return readRow(get, row);
    } catch (e) {
      throw new Rejection(`Row ${row}: ${rowErrorText(e)}`);
    }
  });
}

function rowErrorText(e: unknown) {
  if (e instanceof ZodError) return validationText(e);
  return e instanceof Error ? e.message : String(e);
}

function readCount(value: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value))
    throw new Rejection("Use whole numbers for months, cycles and landings.");
  return Number(value);
}

function readDecimal(value: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Rejection("Use positive hours such as 1234.5.");
  return Number(value);
}

function readYesNo(value: string, column: string, optional = false) {
  const v = value.toLowerCase();
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  if (optional && !v) return undefined;
  throw new Rejection(
    optional
      ? `${column} must be yes, no or blank.`
      : `${column} must be yes or no.`,
  );
}

function planInspections(ctx: PlanContext, rows: InspectionSetupRow[]) {
  const seen = new Set<string>();
  const existing = new Set(
    ctx.s.inspections
      .filter((i) => i.aircraftUuid === ctx.aircraft.uuid && !i.archived)
      .map((i) => norm(i.description)),
  );
  for (const r of rows) {
    const key = `inspection:${r.row}`;
    const where = `Row ${r.row} (${r.name})`;
    if (seen.has(norm(r.name))) {
      ctx.plan.errors.push(`${where}: the name appears twice in the file.`);
      continue;
    }
    seen.add(norm(r.name));
    if (ctx.done.has(key))
      ctx.plan.skipped.push(skippedRow("inspections", key, r.name, DONE));
    else if (existing.has(norm(r.name)))
      ctx.plan.skipped.push(skippedRow("inspections", key, r.name, ON_RECORD));
    else if (checkInspection(ctx, r, where))
      ctx.plan.actions.push({
        step: "inspections",
        key,
        label: r.name,
        detail: inspectionDetail(r),
        command: inspectionCommand(ctx.aircraft.uuid, r),
      });
  }
}

const DONE = "Already saved by this setup";
const ON_RECORD = "Already on record for this aircraft";

function skippedRow(
  step: SkippedRow["step"],
  key: string,
  label: string,
  reason: string,
): SkippedRow {
  return { step, key, label, reason };
}

// Mirrors assertInspectionLimits so the file is fixed before the commit.
function checkInspection(
  ctx: PlanContext,
  r: InspectionSetupRow,
  where: string,
): boolean {
  const errors: string[] = [];
  if (
    [
      r.intervalSeconds,
      r.intervalMonths,
      r.intervalCycles,
      r.intervalLandings,
    ].every((v) => v === undefined)
  )
    errors.push("enter at least one interval.");
  if (
    (r.intervalSeconds && r.lastSeconds === undefined) ||
    (r.intervalCycles && r.lastCycles === undefined) ||
    (r.intervalLandings && r.lastLandings === undefined) ||
    (r.intervalMonths && !r.lastDate)
  )
    errors.push("each interval needs its last-done hours, count or date.");
  if (r.lastDate && r.lastDate > ctx.today)
    errors.push("the last-done date is in the future.");
  if (
    (r.lastSeconds !== undefined &&
      ctx.totalSeconds !== undefined &&
      r.lastSeconds > ctx.totalSeconds) ||
    (r.lastCycles !== undefined && r.lastCycles > ctx.aircraft.cycles) ||
    (r.lastLandings !== undefined && r.lastLandings > ctx.aircraft.landings)
  )
    errors.push("last-done values are above the aircraft's current totals.");
  for (const e of errors) ctx.plan.errors.push(`${where}: ${e}`);
  if (!errors.length) warnInspectionDue(ctx, r, where);
  return !errors.length;
}

function warnInspectionDue(
  ctx: PlanContext,
  r: InspectionSetupRow,
  where: string,
) {
  if (
    r.intervalSeconds &&
    ctx.totalSeconds !== undefined &&
    r.lastSeconds! + r.intervalSeconds <= ctx.totalSeconds
  )
    ctx.plan.warnings.push(`${where}: its hours interval has already run out.`);
}

// "Every 100.0 h, 12 months · last done 2026-03-15 at 2300.5 h"
function inspectionDetail(r: InspectionSetupRow) {
  const every = [
    r.intervalSeconds !== undefined && `${hoursText(r.intervalSeconds)} h`,
    r.intervalMonths && `${r.intervalMonths} months`,
    r.intervalCycles && `${r.intervalCycles} cycles`,
    r.intervalLandings && `${r.intervalLandings} landings`,
  ].filter(Boolean);
  const last = [
    r.lastDate,
    r.lastSeconds !== undefined && `at ${hoursText(r.lastSeconds)} h`,
    r.lastCycles !== undefined && `${r.lastCycles} cycles`,
    r.lastLandings !== undefined && `${r.lastLandings} landings`,
  ].filter(Boolean);
  return `Every ${every.join(", ")} · last done ${last.join(" ")}`;
}

// "PCW 2026-02-10 at 2200 h · next due 2300 h · recurring"
function adDetail(r: AdSetupRow) {
  if (!r.applies) return "Not applicable";
  const due = [
    r.nextDueHours !== undefined && `${r.nextDueHours} h`,
    r.nextDueDate,
  ].filter(Boolean);
  return [
    r.complianceDate
      ? `PCW ${r.complianceDate} at ${r.complianceHours} h`
      : "Applicable",
    due.length ? `next due ${due.join(", ")}` : "no due limit",
    r.recurring === undefined ? "" : r.recurring ? "recurring" : "one-time",
  ]
    .filter(Boolean)
    .join(" · ");
}

const hoursText = (seconds: number) => (seconds / SECONDS_PER_HOUR).toFixed(1);

function inspectionCommand(
  aircraftUuid: string,
  r: InspectionSetupRow,
): ManagementCommand {
  return {
    requestUuid: crypto.randomUUID(),
    reason: SETUP_INSPECTION_REASON,
    action: "inspection.save",
    record: {
      uuid: crypto.randomUUID(),
      version: 0,
      aircraftUuid,
      reference: r.notes,
      description: r.name,
      materials: "",
      archived: false,
      intervalSeconds: r.intervalSeconds,
      intervalMonths: r.intervalMonths,
      intervalCycles: r.intervalCycles,
      intervalLandings: r.intervalLandings,
      lastDate: r.lastDate,
      lastSeconds: r.lastSeconds,
      lastCycles: r.lastCycles,
      lastLandings: r.lastLandings,
    },
  };
}

function planAds(ctx: PlanContext, rows: AdSetupRow[]) {
  const seen = new Set<string>();
  const existing = new Set(
    (ctx.s.airworthiness ?? [])
      .filter((r) => r.aircraftUuid === ctx.aircraft.uuid && !r.componentUuid)
      .map((r) => adNumber(r.source.number)),
  );
  for (const r of rows) {
    const key = `ad:${r.row}`;
    const where = `Row ${r.row} (AD ${r.number})`;
    if (seen.has(adNumber(r.number))) {
      ctx.plan.errors.push(
        `${where}: the AD number appears twice in the file.`,
      );
      continue;
    }
    seen.add(adNumber(r.number));
    if (ctx.done.has(key))
      ctx.plan.skipped.push(skippedRow("ads", key, r.number, DONE));
    else if (existing.has(adNumber(r.number)))
      ctx.plan.skipped.push(skippedRow("ads", key, r.number, ON_RECORD));
    else if (checkAd(ctx, r, where))
      ctx.plan.actions.push({
        step: "ads",
        key,
        label: r.number,
        detail: adDetail(r),
        command: adCommand(ctx.aircraft.uuid, r),
      });
  }
}

// Mirrors assertApplicabilityDecision for the PCW and Applicable cases.
function checkAd(ctx: PlanContext, r: AdSetupRow, where: string): boolean {
  const errors: string[] = [];
  if (r.complianceDate && r.complianceDate > ctx.today)
    errors.push("the compliance date is in the future.");
  if (r.applies && r.complianceDate && r.complianceHours === undefined)
    errors.push("compliance needs the aircraft total time it was done at.");
  for (const e of errors) ctx.plan.errors.push(`${where}: ${e}`);
  if (!errors.length) warnAdDue(ctx, r, where);
  return !errors.length;
}

function warnAdDue(ctx: PlanContext, r: AdSetupRow, where: string) {
  if (!r.applies) return;
  const hoursNow = (ctx.totalSeconds ?? 0) / SECONDS_PER_HOUR;
  if (r.nextDueHours !== undefined && r.nextDueHours <= hoursNow)
    ctx.plan.warnings.push(`${where}: its next due hours have already passed.`);
  if (r.nextDueDate && r.nextDueDate < ctx.localToday)
    ctx.plan.warnings.push(`${where}: its next due date has already passed.`);
  if (
    r.nextDueHours === undefined &&
    !r.nextDueDate &&
    (!r.complianceDate || r.recurring)
  )
    ctx.plan.warnings.push(
      `${where}: no next due limit, so it will show as "Due not set" until one is entered.`,
    );
}

function adCommand(aircraftUuid: string, r: AdSetupRow): ADCommand {
  const record = blankAD(aircraftUuid);
  record.source = {
    ...record.source,
    number: r.number,
    subject: r.title,
    source: SETUP_AD_SOURCE,
    recurring:
      r.recurring === undefined ? "Unknown" : r.recurring ? "Yes" : "No",
    sourceNotes: [r.method && `Method: ${r.method}`, r.notes]
      .filter(Boolean)
      .join("\n"),
  };
  record.reviewRequired = false;
  if (!r.applies) {
    record.applicability = "Not applicable";
    record.reason = r.notes || SETUP_NOT_APPLICABLE_REASON;
  } else if (r.complianceDate) {
    record.applicability = "Previously Complied With (PCW)";
    record.priorCompliance = {
      date: r.complianceDate,
      aircraftHours: r.complianceHours ?? null,
      componentHours: null,
    };
  } else record.applicability = "Applicable";
  record.tasks = adTasks(r);
  return { kind: "save", record, requestUuid: crypto.randomUUID() };
}

// An applicable AD needs an action; a complied one only when something is
// still due or it repeats.
function adTasks(r: AdSetupRow): ADTask[] {
  const hasDue = r.nextDueHours !== undefined || !!r.nextDueDate;
  if (!r.applies || (r.complianceDate && !hasDue && !r.recurring)) return [];
  const recurrence: ADTask["recurrence"] =
    r.recurring === undefined
      ? "Unknown"
      : r.recurring
        ? "Recurring"
        : "One-time";
  return [
    {
      uuid: crypto.randomUUID(),
      description: r.title || `Comply with AD ${r.number}`,
      dueDate: r.nextDueDate ?? "",
      dueHours: r.nextDueHours ?? null,
      dueCycles: null,
      intervalDays: null,
      intervalHours: null,
      intervalCycles: null,
      recurrence,
      workOrderUuid: "",
    },
  ];
}
