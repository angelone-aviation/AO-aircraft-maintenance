/**
 * Responsibility: Airworthiness directive records, the commands that change
 *   them, and the due status of their required actions.
 * Layer: Domain. Pure functions and zod schemas; no I/O, no React (a `now`
 *   or `today` left to its default reads the clock).
 * Dependencies: zod; ./adOwnership, ./adCompliance, ./model, ./programs,
 *   ./components, ./rejection, ./changeLog, ./commandRequest.
 */
import { z } from "zod";
import { adAircraftUuid } from "./adOwnership";
import {
  effectiveCompliance,
  HOURS_ROUNDING_ALLOWANCE,
  lastCompliance,
} from "./adCompliance";
import {
  can,
  latestLocalDate,
  localDate,
  recordedTotalSeconds,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "./model";
import { activeProgram, programPermission } from "./programs";
import {
  componentTotals,
  componentTotalsWithoutTime,
  type Component,
} from "./components";
import { Rejection, StaleRecordRejection } from "./rejection";
import { auditEntry } from "./changeLog";
import { requestUuidField } from "./commandRequest";
export { adAircraftUuid } from "./adOwnership";
export { effectiveCompliance, lastCompliance } from "./adCompliance";

const TEXT_MAX_LENGTH = 20_000;
/** Longest reason for changing an AD or correcting its compliance. */
export const REASON_MAX_LENGTH = 1500;
const URL_MAX_LENGTH = 2000;
// About 1,000 years: a sanity bound on stored day counts, not a service rule.
const MAX_INTERVAL_DAYS = 365_000;
const SECONDS_PER_HOUR = 3600;
const MS_PER_DAY = 86_400_000;
// Days, hours, cycles or landings left at which an action is due soon.
const DUE_SOON_REMAINING = 30;

const text = z.string().trim().max(TEXT_MAX_LENGTH);
const date = z.union([z.iso.date(), z.literal("")]);
const amount = z.number().finite().nonnegative().nullable();

/** An AD's source, as imported from the FAA or entered by hand. */
export const adSourceSchema = z.object({
  number: z.string().trim().min(1).max(100),
  faaModified: z.string().optional(),
  amendment: text,
  issued: text,
  effective: text,
  subject: text,
  recurring: z.enum(["Yes", "No", "Unknown"]),
  supersededBy: text,
  url: z.string().max(URL_MAX_LENGTH),
  source: text,
  section: z.enum(["Airframe", "Engine", "Propeller", "Appliance"]),
  make: text,
  model: text,
  sourceNotes: text,
});

/**
 * A required action of an AD: its next due limits (date, hours, cycles,
 * landings) and the intervals that advance them; null or "" means not set.
 */
export const adTaskSchema = z.object({
  uuid: z.string().uuid(),
  description: z.string().trim().min(1).max(TEXT_MAX_LENGTH),
  dueDate: date,
  dueHours: amount,
  dueCycles: amount,
  dueLandings: z.number().int().nonnegative().nullable().optional(),
  intervalLandings: z.number().int().positive().nullable().optional(),
  intervalDays: z.number().int().positive().max(MAX_INTERVAL_DAYS).nullable(),
  intervalHours: z.number().positive().finite().nullable(),
  intervalCycles: z.number().int().positive().nullable(),
  recurrence: z.enum(["Unknown", "One-time", "Recurring"]).default("Unknown"),
  workOrderUuid: z.string(),
});

/** One compliance with a required action: date, counters, method, mechanic. */
export const adComplianceSchema = z.object({
  uuid: z.string().uuid(),
  taskUuid: z.string().uuid(),
  date: z.iso.date(),
  hours: amount,
  cycles: amount,
  landings: z.number().int().nonnegative().nullable().optional(),
  method: z.string().trim().min(1).max(TEXT_MAX_LENGTH),
  serviceBulletin: text,
  terminatedBy: text,
  workOrderUuid: z.string(),
  mechanic: z.string().trim().min(1).max(200),
  certificate: text,
  evidence: text,
  recordedAt: z.number(),
  recordedBy: z.string(),
  // A correction is appended as a new entry naming the entry it replaces;
  // the original stays in the history (ADR-0005).
  corrects: z.string().uuid().optional(),
  correctionReason: z.string().max(REASON_MAX_LENGTH).optional(),
});

/** The fields a compliance entry cannot leave blank. */
export const REQUIRED_COMPLIANCE_FIELDS: readonly (keyof ADCompliance)[] = [
  "date",
  "method",
  "mechanic",
];

// What a command may send for an entry: the correction link is set only by
// the correction command, so a forged one on new compliance is dropped.
const complianceInputSchema = adComplianceSchema.omit({
  corrects: true,
  correctionReason: true,
});
const correctionReason = z.string().trim().min(1).max(REASON_MAX_LENGTH);

/**
 * An AD as tracked on one aircraft, or on one component (`componentUuid`):
 * the applicability decision, required actions, the append-only compliance
 * history and the FAA source versions it replaced.
 */
export const adSchema = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  programUuid: z.string().optional(),
  aircraftUuid: z.string().min(1),
  componentUuid: z.string(),
  source: adSourceSchema,
  applicability: z.enum([
    "Needs review",
    "Applicable",
    "Not applicable",
    "Superseded",
    "Previously Complied With (PCW)",
  ]),
  priorCompliance: z
    .object({
      date: z.iso.date(),
      aircraftHours: amount,
      componentHours: amount,
    })
    .optional(),
  reason: text,
  tasks: z.array(adTaskSchema).max(100),
  history: z.array(adComplianceSchema).max(1000),
  sourceHistory: z
    .array(z.object({ at: z.number(), source: adSourceSchema }))
    .max(200),
  reviewRequired: z.boolean(),
  updatedAt: z.number(),
});

/** An AD's FAA source. */
export type ADSource = z.infer<typeof adSourceSchema>;

/** The source's `recurring` answers in the AD form's order: unknown first. */
export const AD_RECURRING_CHOICES: readonly ADSource["recurring"][] = [
  "Unknown",
  "Yes",
  "No",
];

// Stored records keep parsing; new saves and imports must link over http(s).
const writableSourceSchema = adSourceSchema.extend({
  url: z
    .string()
    .max(URL_MAX_LENGTH)
    .regex(
      /^(?:https?:\/\/.+)?$/is,
      "AD source link must start with http:// or https://.",
    ),
});

/** An AD record as stored. */
export type AD = z.infer<typeof adSchema>;
/** A required action of an AD. */
export type ADTask = z.infer<typeof adTaskSchema>;
/** One compliance entry of an AD. */
export type ADCompliance = z.infer<typeof adComplianceSchema>;

/**
 * The applicability decisions under which an AD no longer applies: its
 * actions are not tracked, and {@link adStatus} reports the decision itself.
 */
export const CLOSED_APPLICABILITY: readonly AD["applicability"][] = [
  "Not applicable",
  "Superseded",
];

/**
 * The applicability decisions under which an AD's actions are tracked, worked
 * and complied with.
 */
export const TRACKED_APPLICABILITY: readonly AD["applicability"][] = [
  "Applicable",
  "Previously Complied With (PCW)",
];

/**
 * The {@link adStatus} values that need no one's attention: complied, closed,
 * removed with its component, or not due soon yet. The dashboard's AD panel
 * lists every other AD and the alerts mention it; "Needs review", "Due not
 * set" and "Counter unavailable" are among those.
 */
export const SETTLED_AD_STATUSES: readonly string[] = [
  "Complied",
  "Previously Complied With (PCW)",
  "Not applicable",
  "Superseded",
  "Scheduled",
  "Removed component",
];

// Choosing one of these settles the applicability review.
const SETTLING_APPLICABILITY: readonly AD["applicability"][] = [
  ...CLOSED_APPLICABILITY,
  "Previously Complied With (PCW)",
];

// An overdue action makes the AD overdue even if another cannot be computed.
const AD_STATUS_PRIORITY: readonly string[] = [
  "Overdue",
  "Counter unavailable",
  "Due soon",
  "Due not set",
  "Scheduled",
  "Complied",
];

/**
 * A change to ADs: save one record, import FAA entries for an aircraft,
 * record compliance, or correct a compliance entry (Flight Program
 * administrators only). Saved and imported sources must link over http(s).
 * Each may carry its request id.
 */
export const adCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("save"),
    record: adSchema.extend({ source: writableSourceSchema }),
    // Required when the save corrects a decided AD (adSaveIsCorrection).
    reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
    ...requestUuidField,
  }),
  z.object({
    kind: z.literal("import"),
    aircraftUuid: z.string(),
    entries: z
      .array(
        z.object({ source: writableSourceSchema, componentUuid: z.string() }),
      )
      .min(1)
      .max(500),
    ...requestUuidField,
  }),
  z.object({
    kind: z.literal("comply"),
    uuid: z.string(),
    version: z.number(),
    entry: complianceInputSchema,
    ...requestUuidField,
  }),
  z.object({
    kind: z.literal("correct"),
    uuid: z.string(),
    version: z.number(),
    corrects: z.string().uuid(),
    reason: correctionReason,
    entry: complianceInputSchema,
    ...requestUuidField,
  }),
]);

/** A parsed AD command. */
export type ADCommand = z.infer<typeof adCommandSchema>;

type ImportCommand = Extract<ADCommand, { kind: "import" }>;
type SaveCommand = Extract<ADCommand, { kind: "save" }>;
type ComplyCommand = Extract<ADCommand, { kind: "comply" }>;
type CorrectCommand = Extract<ADCommand, { kind: "correct" }>;
type Counters = { hours: number; cycles: number; landings: number };
// Each counter read on its own; null for one that cannot be read.
type LimitCounters = { [K in keyof Counters]: number | null };
type TaskStatus =
  | "Complied"
  | "Counter unavailable"
  | "Due not set"
  | "Due soon"
  | "Overdue"
  | "Scheduled";

/**
 * An AD number as records are matched on it: upper-case, without spaces.
 *
 * @param s - The number as written.
 * @returns The matching key.
 */
export const adNumber = (s: string) => s.toUpperCase().replace(/\s+/g, "");

/**
 * Whether two of an aircraft's AD records track the same AD: on the same
 * component (or both on the airframe), with the same {@link adNumber}.
 */
export function tracksSameAD(
  a: Pick<AD, "componentUuid" | "source">,
  b: Pick<AD, "componentUuid" | "source">,
) {
  return (
    a.componentUuid === b.componentUuid &&
    adNumber(a.source.number) === adNumber(b.source.number)
  );
}

/**
 * Whether an AD's actions are tracked: its applicability is reviewed, and it
 * applies or was complied with before. Only then is compliance recorded.
 */
export function isTrackedAD(r: Pick<AD, "applicability" | "reviewRequired">) {
  return !r.reviewRequired && TRACKED_APPLICABILITY.includes(r.applicability);
}

/**
 * Records an applicability decision on an AD being edited. Not applicable,
 * superseded and PCW settle the review; "Needs review" reopens it; Applicable
 * leaves it as it was.
 *
 * @returns A copy of the AD with the decision.
 */
export function withApplicability(
  r: AD,
  applicability: AD["applicability"],
): AD {
  const reviewRequired = SETTLING_APPLICABILITY.includes(applicability)
    ? false
    : applicability === "Needs review" || r.reviewRequired;
  return { ...r, applicability, reviewRequired };
}

/** Whether saving this decision needs its reason: an AD not applicable. */
export function needsApplicabilityReason(applicability: AD["applicability"]) {
  return applicability === "Not applicable";
}

/** Whether saving this decision needs the AD that superseded this one. */
export function needsSupersedingAD(applicability: AD["applicability"]) {
  return applicability === "Superseded";
}

/**
 * A manually entered AD awaiting review, with no actions or history.
 *
 * @param aircraftUuid - The aircraft it is entered on.
 * @param section - The FAA section; any but "Airframe" needs a component.
 * @returns The record at version 0, with a new uuid.
 */
export function blankAD(
  aircraftUuid: string,
  section: ADSource["section"] = "Airframe",
): AD {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid,
    componentUuid: "",
    source: {
      number: "",
      amendment: "",
      issued: "",
      effective: "",
      subject: "",
      recurring: "Unknown",
      supersededBy: "",
      url: "",
      source: "Manual entry",
      section,
      make: "",
      model: "",
      sourceNotes: "",
    },
    applicability: "Needs review",
    reason: "",
    tasks: [],
    history: [],
    sourceHistory: [],
    reviewRequired: true,
    updatedAt: 0,
  };
}

/** A new required action with no limits set and unknown recurrence. */
export function blankADTask(): ADTask {
  return {
    uuid: crypto.randomUUID(),
    description: "",
    dueDate: "",
    dueHours: null,
    dueCycles: null,
    intervalDays: null,
    intervalHours: null,
    intervalCycles: null,
    recurrence: "Unknown",
    workOrderUuid: "",
  };
}

/**
 * Whether saving over this stored AD corrects a record. Once applicability is
 * decided or compliance is recorded, every change needs a reason (ADR-0005);
 * the first review of an imported AD does not.
 *
 * @param old - The stored AD, or undefined for a new one.
 */
export function adSaveIsCorrection(old: AD | undefined) {
  return (
    !!old && (old.applicability !== "Needs review" || old.history.length > 0)
  );
}

/**
 * Applies one AD command as the snapshot's user. An import reopens review on
 * each new or changed source; a correction appends an entry.
 *
 * @param s - The working snapshot. On success its `airworthiness` is replaced
 *   and `audit` gains an "ad.<kind>" entry per changed record, newest first,
 *   with {@link adCommandReason} and the record before and after as
 *   {@link adAuditRecord} shows it.
 * @param raw - The command, parsed with {@link adCommandSchema}.
 * @param now - The clock for timestamps, future-date checks and the date a
 *   component's totals are read on.
 * @returns The changed records, versions advanced; [] for an unchanged import.
 * @throws {Rejection} For a refused change, such as "AD not found."; a
 *   StaleRecordRejection for a stale version. The snapshot is left unchanged.
 * @throws {z.ZodError} When the command or a changed record does not parse.
 */
export function applyADCommand(
  s: Snapshot,
  raw: ADCommand,
  now = Date.now(),
): AD[] {
  const cmd = adCommandSchema.parse(raw);
  const prior = s.airworthiness ?? [];
  const all = [...prior];
  const changed =
    cmd.kind === "import"
      ? importADs(s, all, cmd, now)
      : [changeAD(s, all, cmd, now)];
  s.airworthiness = all;
  for (const r of changed) recordADChange(s, cmd, prior, r, now);
  return changed;
}

/**
 * The reason an AD command's audit entries record: a correction's, or the
 * one given for an AD change.
 *
 * @param cmd - The command.
 * @returns The trimmed reason, or undefined when there is none.
 */
export function adCommandReason(cmd: ADCommand) {
  return (cmd.kind === "save" || cmd.kind === "correct") && cmd.reason
    ? cmd.reason.trim()
    : undefined;
}

/**
 * An AD as an audit entry records it: everything that can change, including
 * applicability, review state and every action's due limits. The append-only
 * compliance history and prior source versions stay on the record (they can
 * be large); the entry keeps their counts and the latest compliance entry.
 *
 * @param r - The AD.
 */
export function adAuditRecord(r: AD) {
  const { history, sourceHistory, ...record } = r;
  return {
    ...record,
    complianceEntries: history.length,
    latestCompliance: history.at(-1),
    priorSourceVersions: sourceHistory.length,
  };
}

/**
 * The counters an AD's limits compare against: a component AD's time and
 * cycles since new, else the aircraft's totals; landings are the aircraft's.
 *
 * @param s - The aircraft and the program's components.
 * @param r - The AD.
 * @param today - The local date a component's totals are read on.
 * @returns Hours (decimal), cycles and landings; null when the aircraft or
 *   component is unknown or its totals cannot be read, such as an aircraft
 *   meter without a reading.
 */
export function adCounters(
  s: Snapshot,
  r: AD,
  today = localDate(),
): Counters | null {
  try {
    return readCounters(s, r, today);
  } catch (error) {
    if (error instanceof Rejection) return null;
    throw error;
  }
}

/**
 * The counters an AD's limits compare against, each read on its own, so a
 * meter without a reading leaves the cycles and landings limits judged. A
 * component AD counts only the hours and cycles its component tracks;
 * landings are the aircraft's.
 *
 * @param s - The aircraft and the program's components.
 * @param r - The AD.
 * @param today - The local date a component's totals are read on.
 * @returns Hours (decimal), cycles and landings; null for each one that
 *   cannot be read, all three when the aircraft is unknown.
 */
export function adLimitCounters(
  s: Snapshot,
  r: AD,
  today = localDate(),
): LimitCounters {
  const a = s.aircraft.find((a) => a.uuid === adAircraftUuid(s, r));
  if (!a) return { hours: null, cycles: null, landings: null };
  if (!r.componentUuid) {
    const seconds = recordedTotalSeconds(a);
    const hours = seconds === undefined ? null : seconds / SECONDS_PER_HOUR;
    return { hours, cycles: a.cycles, landings: a.landings };
  }
  const c = findComponent(s, r.componentUuid);
  const totals = c ? readComponentTotals(c, a, today) : null;
  const untimed = totals ?? (c && componentTotalsWithoutTime(c, a, today));
  return {
    hours:
      totals && c?.trackTime ? totals.timeSinceNew / SECONDS_PER_HOUR : null,
    cycles: c?.trackCycles ? (untimed?.cyclesSinceNew ?? null) : null,
    landings: a.landings,
  };
}

/**
 * The due status of one required action, the nearest limit deciding.
 *
 * @param s - The aircraft and the program's components.
 * @param r - The AD.
 * @param t - One of its actions.
 * @param today - The local date calendar limits compare against and a
 *   component's totals are read on.
 * @returns "Complied" when compliance ends it; "Overdue" when any limit is
 *   reached, even if another cannot be read; "Counter unavailable" when a
 *   usage limit cannot be read; "Due not set" when no limit is set, as after
 *   compliance on an action that repeats without a fixed interval; else "Due
 *   soon" (30 or fewer days, hours, cycles or landings left) or "Scheduled".
 */
export function adTaskStatus(
  s: Snapshot,
  r: AD,
  t: ADTask,
  today = localDate(),
): TaskStatus {
  const last = lastCompliance(r, t.uuid);
  if (last && isComplied(r, t, last)) return "Complied";
  const counters = adLimitCounters(s, r, today);
  const status = rankRemaining(t, counters, today);
  // A limit that is reached decides: a counter that cannot be read on one
  // limit must never hide a passed date or a reached limit on another.
  if (status === "Overdue" || !hasUnreadLimit(t, counters)) return status;
  return "Counter unavailable";
}

/**
 * The AD's status: its component's removal, its review or applicability
 * decision, or else the most urgent status among its actions.
 *
 * @param s - The aircraft and the program's components.
 * @param r - The AD.
 * @param today - The local date its actions are judged on.
 * @returns "Removed component", "Needs review", a closed applicability, PCW
 *   for a non-recurring AD without actions, or an {@link adTaskStatus}.
 */
export function adStatus(s: Snapshot, r: AD, today = localDate()) {
  const c = findComponent(s, r.componentUuid);
  if (c && !c.installed) return "Removed component";
  if (r.reviewRequired || r.applicability === "Needs review")
    return "Needs review";
  if (CLOSED_APPLICABILITY.includes(r.applicability)) return r.applicability;
  if (
    r.applicability === "Previously Complied With (PCW)" &&
    !r.tasks.length &&
    r.source.recurring === "No"
  )
    return "Previously Complied With (PCW)";
  const statuses: string[] = r.tasks.map((t) => adTaskStatus(s, r, t, today));
  return AD_STATUS_PRIORITY.find((x) => statuses.includes(x)) ?? "Due not set";
}

/** A due limit that an action may carry without a repeat interval. */
export type InitialLimit = "dueDate" | "dueHours" | "dueCycles" | "dueLandings";

const limitInterval = {
  dueDate: "intervalDays",
  dueHours: "intervalHours",
  dueCycles: "intervalCycles",
  dueLandings: "intervalLandings",
} as const;

const LIMIT_UNITS = {
  dueHours: "hours",
  dueCycles: "cycles",
  dueLandings: "landings",
} as const;

/** One action's one-time limits that compliance should have cleared. */
export type StaleInitialLimit = {
  taskUuid: string;
  limits: InitialLimit[];
  /** The latest compliance on the action, which would now have cleared them. */
  complianceDate: string;
};

/**
 * One-time limits (a due date, hours, cycles or landings without its own
 * repeat interval) left on a repeating action after compliance. Compliance
 * recorded before the #42 fix kept them, which can keep the AD Overdue.
 * They are flagged for review, never cleared automatically: a stored record
 * cannot tell a stale limit from one entered after compliance on purpose.
 *
 * @param r - The AD; only applicable and PCW ADs are checked.
 * @returns One entry per affected action, limits in date, hours, cycles,
 *   landings order.
 */
export function staleInitialLimits(r: AD): StaleInitialLimit[] {
  if (!TRACKED_APPLICABILITY.includes(r.applicability)) return [];
  return r.tasks.flatMap((t) => {
    const last = lastCompliance(r, t.uuid);
    if (!last || last.terminatedBy || !hasInterval(t)) return [];
    const limits = (Object.keys(limitInterval) as InitialLimit[]).filter(
      (k) =>
        (k === "dueDate" ? !!t.dueDate : t[k] != null) && !t[limitInterval[k]],
    );
    return limits.length
      ? [{ taskUuid: t.uuid, limits, complianceDate: last.date }]
      : [];
  });
}

/**
 * A copy of the AD with one action's stale initial limits cleared, to save
 * through the normal AD save (audited, with a reason).
 *
 * @param r - The AD; left unchanged.
 * @param taskUuid - The action to clear.
 * @returns The copy; equal to `r` when that action has no stale limits.
 */
export function clearInitialLimits(r: AD, taskUuid: string): AD {
  const next = structuredClone(r);
  const t = next.tasks.find((t) => t.uuid === taskUuid);
  const stale = staleInitialLimits(r).find((x) => x.taskUuid === taskUuid);
  if (!t || !stale) return next;
  for (const k of stale.limits)
    if (k === "dueDate") t.dueDate = "";
    else t[k] = null;
  return next;
}

/**
 * Names one initial limit for the user.
 *
 * @param t - The action.
 * @param k - The limit.
 * @returns For example "due date 2026-01-01" or "2400 hours".
 */
export function initialLimitLabel(t: ADTask, k: InitialLimit) {
  if (k === "dueDate") return `due date ${t.dueDate}`;
  return `${t[k]} ${LIMIT_UNITS[k]}`;
}

/**
 * What the register shows for a stale initial limit.
 *
 * @param r - The AD.
 * @param stale - One entry from {@link staleInitialLimits}.
 */
export function staleInitialLimitNotice(r: AD, stale: StaleInitialLimit) {
  return `This one-time limit (${describeStaleLimits(r, stale).limits}) was not cleared when compliance was recorded on ${stale.complianceDate}. If compliance satisfied it, clear it.`;
}

/**
 * The reason prefilled when a stale initial limit is cleared.
 *
 * @param r - The AD.
 * @param stale - One entry from {@link staleInitialLimits}.
 */
export function initialLimitClearReason(r: AD, stale: StaleInitialLimit) {
  const { description, limits } = describeStaleLimits(r, stale);
  return `One-time initial limit (${limits}) on "${description}" cleared: satisfied by the compliance recorded on ${stale.complianceDate}, which did not clear it when it was recorded.`;
}

// Logs the record's own program, as the server always has, not the one
// auditEntry would derive from its aircraft.
function recordADChange(
  s: Snapshot,
  cmd: ADCommand,
  prior: AD[],
  r: AD,
  now: number,
) {
  const old = prior.find((x) => x.uuid === r.uuid);
  const change = {
    action: "ad." + cmd.kind,
    entityUuid: r.uuid,
    aircraftUuid: r.aircraftUuid,
    programUuid: r.programUuid,
    reason: adCommandReason(cmd),
    before: old && adAuditRecord(old),
    after: adAuditRecord(r),
  };
  s.audit.unshift(auditEntry(s, change, now));
}

function putAD(all: AD[], r: AD) {
  const i = all.findIndex((x) => x.uuid === r.uuid);
  if (i < 0) all.push(r);
  else all[i] = r;
}

function importADs(s: Snapshot, all: AD[], cmd: ImportCommand, now: number) {
  if (!can(s, cmd.aircraftUuid, "maintenance"))
    throw new Rejection("Aircraft maintenance permission required.");
  const seen = new Set<string>();
  const changed: AD[] = [];
  for (const e of cmd.entries) {
    const key = adNumber(e.source.number) + "|" + e.componentUuid;
    if (seen.has(key))
      throw new Rejection("Duplicate AD and component in import.");
    seen.add(key);
    const r = importEntry(s, all, cmd.aircraftUuid, e, now);
    if (!r) continue;
    putAD(all, r);
    changed.push(r);
  }
  return changed;
}

// An unchanged source leaves the record, and its review, as they are.
function importEntry(
  s: Snapshot,
  all: AD[],
  aircraftUuid: string,
  e: ImportCommand["entries"][number],
  now: number,
): AD | undefined {
  const old = all.find(
    (r) =>
      adAircraftUuid(s, r) === aircraftUuid &&
      r.componentUuid === e.componentUuid &&
      adNumber(r.source.number) === adNumber(e.source.number),
  );
  const r = old
    ? structuredClone(old)
    : blankAD(aircraftUuid, e.source.section);
  r.componentUuid = e.componentUuid;
  assertADOwner(s, r);
  if (old && JSON.stringify(old.source) === JSON.stringify(e.source)) return;
  if (old) r.sourceHistory.push({ at: now, source: old.source });
  r.source = e.source;
  r.reviewRequired = true;
  r.version++;
  r.programUuid = activeProgram(s);
  r.updatedAt = now;
  return adSchema.parse(r);
}

function changeAD(
  s: Snapshot,
  all: AD[],
  cmd: SaveCommand | ComplyCommand | CorrectCommand,
  now: number,
): AD {
  const uuid = cmd.kind === "save" ? cmd.record.uuid : cmd.uuid;
  const old = all.find((r) => r.uuid === uuid);
  if (cmd.kind !== "save" && !old) throw new Rejection("AD not found.");
  const r = structuredClone(cmd.kind === "save" ? cmd.record : old!);
  assertADOwner(s, r);
  const expected = cmd.kind === "save" ? r.version : cmd.version;
  if ((old?.version ?? 0) !== expected)
    throw new StaleRecordRejection("ad", old?.version ?? 0);
  if (
    old &&
    (old.aircraftUuid !== r.aircraftUuid ||
      old.componentUuid !== r.componentUuid)
  )
    throw new Rejection(
      "An existing AD cannot be reassigned to another asset.",
    );
  if (cmd.kind === "save") saveAD(s, all, cmd, old, r, now);
  else if (cmd.kind === "comply") recordCompliance(s, cmd, r, now);
  else recordCorrection(s, cmd, r, now);
  r.programUuid = activeProgram(s);
  r.version = (old?.version ?? 0) + 1;
  r.updatedAt = now;
  const changed = adSchema.parse(r);
  putAD(all, changed);
  return changed;
}

function saveAD(
  s: Snapshot,
  all: AD[],
  cmd: SaveCommand,
  old: AD | undefined,
  r: AD,
  now: number,
) {
  if (adSaveIsCorrection(old) && !cmd.reason)
    throw new Rejection("Record the reason for changing this AD.");
  assertLimitsSeeCompliance(old, r);
  r.history = old?.history ?? [];
  r.sourceHistory = old?.sourceHistory ?? [];
  if (old && JSON.stringify(old.source) !== JSON.stringify(r.source))
    r.sourceHistory = [...r.sourceHistory, { at: now, source: old.source }];
  assertApplicabilityDecision(r, now);
  assertActions(s, old, r);
  const duplicate = all.some(
    (x) =>
      x.uuid !== r.uuid &&
      adAircraftUuid(s, x) === adAircraftUuid(s, r) &&
      tracksSameAD(x, r),
  );
  if (duplicate)
    throw new Rejection("This AD already exists for the selected asset.");
}

function assertApplicabilityDecision(r: AD, now: number) {
  if (needsSupersedingAD(r.applicability) && !r.source.supersededBy)
    throw new Rejection("Enter the superseding AD in Superseded by.");
  if (needsApplicabilityReason(r.applicability) && !r.reason)
    throw new Rejection("Record the reason this AD is not applicable.");
  if (r.applicability === "Previously Complied With (PCW)")
    assertPriorCompliance(r, now);
  if (r.applicability === "Applicable" && !r.tasks.length)
    throw new Rejection("Add at least one required action.");
}

function assertPriorCompliance(r: AD, now: number) {
  const pcw = r.priorCompliance;
  if (!pcw || pcw.date > latestLocalDate(now))
    throw new Rejection(
      "Record a previous compliance date that is not in the future.",
    );
  if (
    pcw.aircraftHours === null &&
    (!r.componentUuid || pcw.componentHours === null)
  )
    throw new Rejection(
      "Record aircraft total time or, for a component AD, component total time.",
    );
  if (!r.componentUuid && pcw.componentHours !== null)
    throw new Rejection(
      "Component total time is only available for component ADs.",
    );
}

function assertActions(s: Snapshot, old: AD | undefined, r: AD) {
  if (new Set(r.tasks.map((t) => t.uuid)).size !== r.tasks.length)
    throw new Rejection("Duplicate action identifiers.");
  if (old?.history.some((h) => !r.tasks.some((t) => t.uuid === h.taskUuid)))
    throw new Rejection("Actions with compliance history cannot be removed.");
  for (const t of r.tasks) {
    validateWorkOrder(s, t.workOrderUuid, adAircraftUuid(s, r));
    if (t.recurrence === "One-time" && hasInterval(t))
      throw new Rejection("One-time actions cannot have repeating intervals.");
  }
}

// A save carries the history its form loaded. Compliance moves an action's
// next due, so a save that has not seen a later entry for an action may not
// set that action's limits: it would put back the due point the compliance
// replaced (a re-sent stale draft), even at the current version.
function assertLimitsSeeCompliance(old: AD | undefined, r: AD) {
  if (!old) return;
  const seen = new Set(r.history.map((h) => h.uuid));
  old.tasks.forEach((stored, index) => {
    const unseen = old.history.some(
      (h) => h.taskUuid === stored.uuid && !seen.has(h.uuid),
    );
    const sent = r.tasks.find((t) => t.uuid === stored.uuid);
    if (!unseen || !sent || sameLimits(sent, stored)) return;
    throw new Rejection(
      `Compliance was recorded on required action ${index + 1} after this AD was opened, which moved its next due. Reload the AD before changing that action's due limits.`,
    );
  });
}

const TASK_LIMIT_FIELDS = [
  "dueDate",
  "dueHours",
  "dueCycles",
  "dueLandings",
  "intervalDays",
  "intervalHours",
  "intervalCycles",
  "intervalLandings",
  "recurrence",
] as const satisfies readonly (keyof ADTask)[];

function sameLimits(a: ADTask, b: ADTask) {
  return TASK_LIMIT_FIELDS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

function recordCompliance(s: Snapshot, cmd: ComplyCommand, r: AD, now: number) {
  if (!isTrackedAD(r))
    throw new Rejection("Review applicability before recording compliance.");
  const t = r.tasks.find((t) => t.uuid === cmd.entry.taskUuid);
  if (!t) throw new Rejection("Required action not found.");
  const entry = { ...cmd.entry, recordedAt: now, recordedBy: s.user.id };
  if (r.history.some((h) => h.uuid === entry.uuid))
    throw new Rejection("Compliance entry already recorded.");
  checkEntry(s, r, t, entry, now, lastCompliance(r, t.uuid));
  r.history.push(entry);
  if (hasInterval(t)) advanceDue(t, entry);
  else clearSatisfiedLimits(t, entry);
}

function recordCorrection(
  s: Snapshot,
  cmd: CorrectCommand,
  r: AD,
  now: number,
) {
  assertProgramAdministrator(s, r);
  const target = r.history.find((h) => h.uuid === cmd.corrects);
  if (!target) throw new Rejection("Compliance entry not found.");
  // Every correction names the original entry, so the latest wins.
  const root = target.corrects ?? target.uuid;
  const t = r.tasks.find((t) => t.uuid === target.taskUuid);
  if (!t) throw new Rejection("Required action not found.");
  if (cmd.entry.taskUuid !== t.uuid)
    throw new Rejection("A correction must be for the same required action.");
  const entry: ADCompliance = {
    ...cmd.entry,
    recordedAt: now,
    recordedBy: s.user.id,
    corrects: root,
    correctionReason: cmd.reason,
  };
  if (r.history.some((h) => h.uuid === entry.uuid))
    throw new Rejection("Compliance entry already recorded.");
  const entries = effectiveCompliance(r).filter((h) => h.taskUuid === t.uuid);
  const i = entries.findIndex((h) => (h.corrects ?? h.uuid) === root);
  if (i < 0) throw new Rejection("Compliance entry not found.");
  if (complianceValues(entries[i]) === complianceValues(entry))
    throw new Rejection(
      "Change at least one field before saving a correction.",
    );
  checkEntry(s, r, t, entry, now, entries[i - 1], entries[i + 1]);
  r.history.push(entry);
  // The latest entry sets the next due, so correcting it recalculates it.
  if (i === entries.length - 1) advanceDue(t, entry);
}

function assertProgramAdministrator(s: Snapshot, r: AD) {
  const program = s.aircraft.find(
    (a) => a.uuid === adAircraftUuid(s, r),
  )?.programUuid;
  if (!programPermission(s, "admin", program))
    throw new Rejection(
      "Flight Program administrator permission is required to correct a compliance record.",
    );
}

function assertADOwner(s: Snapshot, r: AD) {
  if (!can(s, adAircraftUuid(s, r), "maintenance"))
    throw new Rejection("Aircraft maintenance permission required.");
  if (!r.componentUuid && r.source.section !== "Airframe")
    throw new Rejection("Select the specific component for this AD.");
  if (r.componentUuid && !isComponentOfAD(s, r))
    throw new Rejection("Select a component belonging to this aircraft.");
}

// A new AD's component must be recorded on its aircraft. A saved AD follows
// its installed component (adAircraftUuid) and stays with a removed one.
function isComponentOfAD(s: Snapshot, r: AD) {
  const c = findComponent(s, r.componentUuid);
  if (!c) return false;
  if (r.version !== 0 && !c.installed) return true;
  const aircraftUuid = r.version === 0 ? r.aircraftUuid : adAircraftUuid(s, r);
  return c.aircraftUuid === aircraftUuid;
}

function validateWorkOrder(s: Snapshot, id: string, aircraftUuid: string) {
  if (!id) return;
  const w = s.workOrders?.find(
    (w) => w.uuid === id && w.aircraftUuid === aircraftUuid,
  );
  if (!w || w.status === "cancelled")
    throw new Rejection("Select an appropriate work order for this aircraft.");
}

function findComponent(s: Snapshot, uuid: string): Component | undefined {
  const c = s.management?.find(
    (c) => c.kind === "component" && c.uuid === uuid,
  );
  return c?.kind === "component" ? c : undefined;
}

function hasInterval(t: ADTask) {
  return !!(
    t.intervalDays ||
    t.intervalHours ||
    t.intervalCycles ||
    t.intervalLandings
  );
}

// The fields a correction must change at least one of.
function complianceValues(h: ADCompliance) {
  return JSON.stringify([
    h.date,
    h.hours,
    h.cycles,
    h.landings ?? null,
    h.method,
    h.serviceBulletin,
    h.terminatedBy,
    h.workOrderUuid,
    h.mechanic,
    h.certificate,
    h.evidence,
  ]);
}

// Checks a completion against the action's neighbouring entries (the last
// one for new compliance; both for a correction) and the current totals.
function checkEntry(
  s: Snapshot,
  r: AD,
  t: ADTask,
  entry: ADCompliance,
  now: number,
  prev?: ADCompliance,
  next?: ADCompliance,
) {
  validateWorkOrder(s, entry.workOrderUuid, adAircraftUuid(s, r));
  assertEntryDate(entry, now, prev, next);
  if (
    (t.intervalHours && entry.hours === null) ||
    (t.intervalCycles && entry.cycles === null) ||
    (t.intervalLandings && entry.landings == null)
  )
    throw new Rejection("Record the counter needed to calculate the next due.");
  assertEntryCounters(entry, prev, next);
  assertEntryLandings(s, r, entry, prev);
  assertWithinTotals(s, r, entry, now);
}

function assertEntryDate(
  entry: ADCompliance,
  now: number,
  prev?: ADCompliance,
  next?: ADCompliance,
) {
  if (entry.date > latestLocalDate(now))
    throw new Rejection("Completion date cannot be in the future.");
  if (prev && entry.date < prev.date)
    throw new Rejection("Completion date precedes the last compliance entry.");
  if (next && entry.date > next.date)
    throw new Rejection("Completion date is after the next compliance entry.");
}

function assertEntryCounters(
  entry: ADCompliance,
  prev?: ADCompliance,
  next?: ADCompliance,
) {
  if (
    prev &&
    (isBelow(entry.hours, prev.hours) || isBelow(entry.cycles, prev.cycles))
  )
    throw new Rejection(
      "Completion counters precede the last compliance entry.",
    );
  if (
    next &&
    (isBelow(next.hours, entry.hours) ||
      isBelow(next.cycles, entry.cycles) ||
      isBelow(next.landings, entry.landings))
  )
    throw new Rejection(
      "Completion counters are after the next compliance entry.",
    );
}

function assertEntryLandings(
  s: Snapshot,
  r: AD,
  entry: ADCompliance,
  prev?: ADCompliance,
) {
  if (entry.landings == null) return;
  const total = s.aircraft.find(
    (a) => a.uuid === adAircraftUuid(s, r),
  )?.landings;
  if (
    total === undefined ||
    entry.landings > total ||
    entry.landings < (prev?.landings ?? 0)
  )
    throw new Rejection(
      "Completion landings must be between last compliance and the aircraft total.",
    );
}

function assertWithinTotals(
  s: Snapshot,
  r: AD,
  entry: ADCompliance,
  now: number,
) {
  const counters = readCounters(s, r, localDate(now));
  if (!counters) return;
  const component = findComponent(s, r.componentUuid);
  const hoursOver =
    entry.hours !== null &&
    (!component || component.trackTime) &&
    entry.hours > counters.hours + HOURS_ROUNDING_ALLOWANCE;
  const cyclesOver =
    entry.cycles !== null &&
    (!component || component.trackCycles) &&
    entry.cycles > counters.cycles;
  if (hoursOver || cyclesOver)
    throw new Rejection(
      "Completion hours and cycles cannot exceed the current totals.",
    );
}

function isBelow(a?: number | null, b?: number | null) {
  return a != null && b != null && a < b;
}

// An action without a repeat interval has no next due to work out, so new
// compliance clears the limits it satisfied. Any limit on the action after
// that was entered since ("at the next annual") and counts. A correction
// does not come here: it must not clear a limit entered after the original.
function clearSatisfiedLimits(t: ADTask, entry: ADCompliance) {
  if (entry.terminatedBy) return;
  t.dueDate = "";
  t.dueHours = null;
  t.dueCycles = null;
  t.dueLandings = null;
}

// Repeating limits advance from the completion; an initial limit without a
// repeat interval is satisfied by it, as on inspections.
function advanceDue(t: ADTask, entry: ADCompliance) {
  if (entry.terminatedBy || !hasInterval(t)) return;
  t.dueDate = t.intervalDays ? addDays(entry.date, t.intervalDays) : "";
  t.dueHours = t.intervalHours ? entry.hours! + t.intervalHours : null;
  t.dueCycles = t.intervalCycles ? entry.cycles! + t.intervalCycles : null;
  t.dueLandings = t.intervalLandings
    ? entry.landings! + t.intervalLandings
    : null;
}

function addDays(isoDate: string, days: number) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// adCounters, except that an aircraft meter without a reading throws its
// Rejection: compliance on an aircraft AD is refused until there is a reading
// to check its hours against.
function readCounters(s: Snapshot, r: AD, today: string): Counters | null {
  const a = s.aircraft.find((a) => a.uuid === adAircraftUuid(s, r));
  if (!a) return null;
  if (!r.componentUuid)
    return {
      hours: totalSeconds(a) / SECONDS_PER_HOUR,
      cycles: a.cycles,
      landings: a.landings,
    };
  const c = findComponent(s, r.componentUuid);
  const t = c && readComponentTotals(c, a, today);
  if (!t) return null;
  return {
    hours: t.timeSinceNew / SECONDS_PER_HOUR,
    cycles: t.cyclesSinceNew,
    landings: a.landings,
  };
}

// Totals that cannot be computed (readings before the installation baseline,
// a missing meter reading) leave the counter unavailable, not the AD failing.
// Those are Rejections; any other error is a fault and propagates.
function readComponentTotals(c: Component, a: Aircraft, today: string) {
  try {
    return componentTotals(c, a, today);
  } catch (error) {
    if (error instanceof Rejection) return null;
    throw error;
  }
}

function isComplied(r: AD, t: ADTask, last: ADCompliance) {
  return (
    !!last.terminatedBy ||
    t.recurrence === "One-time" ||
    (!hasInterval(t) &&
      t.recurrence !== "Recurring" &&
      r.source.recurring === "No")
  );
}

function hasUnreadLimit(t: ADTask, c: LimitCounters) {
  return (
    (t.dueHours !== null && c.hours === null) ||
    (t.dueCycles !== null && c.cycles === null) ||
    (t.dueLandings != null && c.landings === null)
  );
}

// One rule for every maintenance limit (GLOSSARY "Overdue"): a usage limit
// is reached at 0 remaining, because the next flight would exceed it; a
// calendar limit stays valid through its due date. Hours compare in whole
// seconds, as inspections do, so floating-point noise cannot hide a 0. A
// limit whose counter cannot be read is left out.
function rankRemaining(t: ADTask, c: LimitCounters, today: string): TaskStatus {
  const days = t.dueDate
    ? [(Date.parse(t.dueDate) - Date.parse(today)) / MS_PER_DAY]
    : [];
  const usage = [
    ...(c.hours !== null && t.dueHours !== null
      ? [
          Math.round((t.dueHours - c.hours) * SECONDS_PER_HOUR) /
            SECONDS_PER_HOUR,
        ]
      : []),
    ...(c.cycles !== null && t.dueCycles !== null
      ? [t.dueCycles - c.cycles]
      : []),
    ...(c.landings !== null && t.dueLandings != null
      ? [t.dueLandings - c.landings]
      : []),
  ];
  if (days.some((n) => n < 0) || usage.some((n) => n <= 0)) return "Overdue";
  const remaining = [...days, ...usage];
  if (remaining.some((n) => n <= DUE_SOON_REMAINING)) return "Due soon";
  return remaining.length ? "Scheduled" : "Due not set";
}

function describeStaleLimits(r: AD, stale: StaleInitialLimit) {
  const t = r.tasks.find((t) => t.uuid === stale.taskUuid);
  return {
    description: t?.description ?? "",
    limits: t
      ? stale.limits.map((k) => initialLimitLabel(t, k)).join(", ")
      : "",
  };
}
