/**
 * Responsibility: Turning a reviewed inspection template into a schedule on
 *   one aircraft or component, with draft task cards for its tasks.
 * Layer: Domain. Zod schema, rules and one applier; no I/O, no React.
 * Dependencies: zod, ./inspectionTemplates, ./model, ./programs,
 *   ./manualDiscovery, ./management, ./maintenance, ./components,
 *   ./components/calendar, ./taskCards, ./rejection.
 */
import { z } from "zod";
import {
  taskSourceText,
  taskApplicabilityText,
  type InspectionTemplate,
} from "./inspectionTemplates";
import { REQUIREMENT_WARNING_DEFAULTS, type Component } from "./components";
import { can, type Snapshot } from "./model";
import { ownsActive } from "./programs";
import { matchesAircraft, matchesComponent } from "./manualDiscovery";
import { applyManagement } from "./management";
import { endOfDueMonth } from "./maintenance";
import { calendarDue } from "./components/calendar";
import { saveTaskCard, taskCardDefaults } from "./taskCards";
import { Rejection, StaleRecordRejection } from "./rejection";

const HOUR_SECONDS = 3600;
const MONTHS_PER_YEAR = 12;

/** The longest description a schedule made from a template may carry. */
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 2000;

const count = z.number().int().nonnegative();

/**
 * A request to schedule a template's first-time ("initial") or recurring
 * limits on an aircraft or component, with the last compliance.
 *
 * @throws {z.ZodError} From `parse()` on a blank or over-long description, a
 *   bad count or date, or `reviewed` not true.
 */
export const activateTemplateSchema = z.strictObject({
  usageMeter: z.enum(["aircraft", "collective"]).optional(),
  templateUuid: z.string().uuid(),
  templateVersion: count,
  targetUuid: z.string().min(1),
  mode: z.enum(["initial", "recurring"]),
  description: z.string().trim().min(1).max(TEMPLATE_DESCRIPTION_MAX_LENGTH),
  lastSeconds: count.optional(),
  lastCycles: count.optional(),
  lastLandings: count.optional(),
  lastDate: z.iso.date().optional(),
  reviewed: z.literal(true),
});

/** A request to schedule a template. */
export type ActivateTemplateInput = z.infer<typeof activateTemplateSchema>;

/**
 * A template schedule's limits, and which of them are absolute rather than
 * counted from the last compliance.
 */
export interface TemplateLimits {
  hours?: number;
  cycles?: number;
  landings?: number;
  /** The recurring calendar interval, in the template's calendar unit. */
  calendar?: number;
  absoluteHours: boolean;
  absoluteCycles: boolean;
  absoluteLandings: boolean;
}

/**
 * Hours (not seconds), cycles, landings and a date (YYYY-MM-DD), any of them
 * unknown.
 */
export interface ScheduleReadings {
  hours?: number;
  cycles?: number;
  landings?: number;
  date?: string;
}

/**
 * Explains why an aircraft template cannot become a schedule yet.
 *
 * @param t - The template.
 * @returns The reason (recurring days, or hours not counted from new), or ""
 *   when it can be activated.
 */
export function templateActivationIssue(t: InspectionTemplate) {
  if (
    t.applicability.kind === "aircraft" &&
    t.calendarValue &&
    t.calendarUnit === "DAYS"
  )
    return "Aircraft inspection schedules currently support months or years, not recurring days. Keep this template until a day-based schedule is available.";
  if (t.applicability.kind === "aircraft" && t.hours && t.timeBasis !== "TSN")
    return "Aircraft inspections use aircraft total time. Use a component-model template for TSO or TSR limits.";
  return "";
}

/**
 * The source key stamped on each schedule made from a template, so that a
 * second schedule of one template and mode on one target is refused.
 *
 * @param templateUuid - The template.
 * @param mode - The initial or recurring schedule.
 * @returns `template:<templateUuid>:<mode>`.
 */
export function templateSourceKey(
  templateUuid: string,
  mode: ActivateTemplateInput["mode"],
): string {
  return `template:${templateUuid}:${mode}`;
}

/**
 * Whether a template's schedule already exists on a target, so activating it
 * again is refused: an inspection with its source key on the target's
 * aircraft (a component's aircraft too, as the template may have moved from
 * an aircraft model), or a component requirement with it on the target.
 *
 * @param s - The inspections, components and component requirements.
 * @param t - The template.
 * @param mode - The initial or recurring schedule.
 * @param targetUuid - The aircraft or component chosen.
 * @returns True when the schedule exists.
 */
export function templateScheduleExists(
  s: Snapshot,
  t: Pick<InspectionTemplate, "uuid" | "applicability">,
  mode: ActivateTemplateInput["mode"],
  targetUuid: string,
): boolean {
  const sourceKey = templateSourceKey(t.uuid, mode);
  const aircraftUuid =
    t.applicability.kind === "component"
      ? s.management?.find(
          (c): c is Component =>
            c.kind === "component" && c.uuid === targetUuid,
        )?.aircraftUuid
      : targetUuid;
  return (
    s.inspections.some(
      (i) => i.sourceKey === sourceKey && i.aircraftUuid === aircraftUuid,
    ) ||
    !!s.management?.some(
      (r) =>
        r.kind === "componentRequirement" &&
        r.sourceKey === sourceKey &&
        r.componentUuid === targetUuid,
    )
  );
}

/**
 * The limits of a schedule made from the template. An initial schedule takes
 * the first-time thresholds, always absolute and without a calendar limit.
 *
 * @param t - The template.
 * @param initial - True for the initial schedule, false for the recurring one.
 * @returns The limits, possibly none.
 */
export function templateLimits(
  t: InspectionTemplate,
  initial: boolean,
): TemplateLimits {
  return {
    hours: initial ? t.initialHours : t.hours,
    cycles: initial ? t.initialCycles : t.cycles,
    landings: initial ? t.initialLandings : t.landings,
    calendar: initial ? undefined : t.calendarValue,
    absoluteHours: initial || t.hourMode === "ABSOLUTE",
    absoluteCycles: initial || t.cycleMode === "ABSOLUTE",
    // Older templates have no landing mode; theirs count from the last
    // compliance.
    absoluteLandings: initial || t.landingMode === "ABSOLUTE",
  };
}

/**
 * When a schedule made from the template first falls due: an absolute limit
 * as it stands, any other limit after the last compliance (hours to the
 * tenth), and the calendar limit from the last compliance date, to the end of
 * the due month for an aircraft inspection. A limit is left out when its last
 * compliance is missing or the date is not a valid date.
 *
 * @param t - The template.
 * @param initial - True for the initial schedule, false for the recurring one.
 * @param last - The last compliance.
 * @returns The due hours, cycles, landings and date.
 */
export function templateNextDue(
  t: InspectionTemplate,
  initial: boolean,
  last: ScheduleReadings,
): ScheduleReadings {
  const limits = templateLimits(t, initial);
  return {
    hours: dueAfter(
      limits.hours,
      last.hours,
      limits.absoluteHours,
      // Hours are kept in tenths; this also hides floating-point noise.
      (sum) => Number(sum.toFixed(1)),
    ),
    cycles: dueAfter(limits.cycles, last.cycles, limits.absoluteCycles),
    landings: dueAfter(limits.landings, last.landings, limits.absoluteLandings),
    date: readCalendarDue(t, limits.calendar, last.date),
  };
}

/**
 * Creates an inspection (aircraft template) or component requirement
 * (component template), once per target, and a draft task card per task.
 *
 * @param s - The working snapshot; it gets the records and their change log
 *   entries, or nothing on any refusal.
 * @param raw - The request.
 * @returns The schedule, its task cards, and their aircraft.
 * @throws {Rejection} When the template is unavailable, stale or unsupported,
 *   the target does not match, there are no limits, or it already exists.
 */
export function activateTemplate(s: Snapshot, raw: ActivateTemplateInput) {
  const input = activateTemplateSchema.parse(raw);
  const t = findActivatableTemplate(s, input);
  const component = findTargetComponent(s, t, input.targetUuid);
  const aircraftUuid = component ? component.aircraftUuid : input.targetUuid;
  assertMaintainableAircraft(s, t, aircraftUuid);
  const limits = readScheduleLimits(t, input.mode === "initial");
  if (templateScheduleExists(s, t, input.mode, input.targetUuid))
    throw new Rejection(
      "This template schedule already exists for the selected target. Open the existing record to edit it.",
    );
  const sourceKey = templateSourceKey(t.uuid, input.mode);
  const nextState = structuredClone(s);
  const uuid = crypto.randomUUID();
  const a: Activation = { t, input, limits, uuid, sourceKey, aircraftUuid };
  const result = applyManagement(
    nextState,
    component ? requirementCommand(a, component.uuid) : inspectionCommand(a),
  );
  const links = component
    ? {
        inspectionUuid: "",
        componentUuid: component.uuid,
        requirementUuid: uuid,
      }
    : { inspectionUuid: uuid, componentUuid: "", requirementUuid: "" };
  const tasks = createTaskCards(nextState, a, links);
  s.inspections = nextState.inspections;
  s.management = nextState.management;
  s.taskCards = nextState.taskCards;
  s.audit = nextState.audit;
  return { record: result.next, tasks, aircraftUuid };
}

interface Activation {
  t: InspectionTemplate;
  input: ActivateTemplateInput;
  limits: TemplateLimits;
  uuid: string;
  sourceKey: string;
  aircraftUuid: string;
}

function findActivatableTemplate(s: Snapshot, input: ActivateTemplateInput) {
  const t = s.inspectionTemplates?.find((t) => t.uuid === input.templateUuid);
  if (!t || !ownsActive(s, t.programUuid))
    throw new Rejection("Template is unavailable in this Flight Program.");
  if (t.version !== input.templateVersion)
    throw new StaleRecordRejection("inspectionTemplate", t.version);
  if (t.archived)
    throw new Rejection(
      "Template changed or was archived. Reopen it before creating a schedule.",
    );
  const issue = templateActivationIssue(t);
  if (issue) throw new Rejection(issue);
  return t;
}

function findTargetComponent(
  s: Snapshot,
  t: InspectionTemplate,
  targetUuid: string,
) {
  if (t.applicability.kind !== "component") return undefined;
  const component = s.management?.find(
    (c) => c.kind === "component" && c.uuid === targetUuid,
  );
  if (
    !component ||
    component.kind !== "component" ||
    !component.installed ||
    !component.aircraftUuid ||
    !matchesComponent(component, t.applicability)
  )
    throw new Rejection("Choose an installed component of the template model.");
  return component;
}

function assertMaintainableAircraft(
  s: Snapshot,
  t: InspectionTemplate,
  aircraftUuid: string,
) {
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (
    !aircraft ||
    !can(s, aircraftUuid, "maintenance") ||
    (t.applicability.kind === "aircraft" &&
      !matchesAircraft(aircraft, t.applicability))
  )
    throw new Rejection("Choose a matching aircraft with maintenance access.");
}

function readScheduleLimits(t: InspectionTemplate, initial: boolean) {
  const limits = templateLimits(t, initial);
  if (
    limits.hours === undefined &&
    limits.cycles === undefined &&
    limits.landings === undefined &&
    limits.calendar === undefined
  )
    throw new Rejection(
      "This schedule has no numeric limits. Add verified intervals to the template first.",
    );
  return limits;
}

// A component requirement keeps each limit as an interval with its mode.
function requirementCommand(a: Activation, componentUuid: string) {
  const { t, input, limits } = a;
  return {
    action: "record.save" as const,
    requestUuid: crypto.randomUUID(),
    reason: `Created from template ${t.name}, version ${t.version}.`,
    record: {
      ...scheduleFields(a),
      kind: "componentRequirement" as const,
      componentUuid,
      requirementType: t.requirementType,
      description: t.name,
      notes: [input.description, t.conditions].filter(Boolean).join("\n\n"),
      intervalSeconds: toSeconds(limits.hours),
      intervalCycles: limits.cycles,
      intervalLandings: limits.landings,
      landingLimitMode: limitMode(limits.absoluteLandings),
      calendarIntervalValue: limits.calendar,
      calendarIntervalUnit: t.calendarUnit,
      timeBasis: t.timeBasis,
      timeLimitMode: limitMode(limits.absoluteHours),
      cycleLimitMode: limitMode(limits.absoluteCycles),
      ...REQUIREMENT_WARNING_DEFAULTS,
    },
  };
}

// An inspection keeps an absolute limit as a due value and a recurring one as
// an interval; its calendar interval is in months.
function inspectionCommand(a: Activation) {
  const { t, input, limits } = a;
  const { hours, cycles, landings, calendar } = limits;
  return {
    action: "inspection.save" as const,
    requestUuid: crypto.randomUUID(),
    reason: `Created from template ${t.name}, version ${t.version}.`,
    record: {
      ...scheduleFields(a),
      usageMeter: input.usageMeter,
      reference: t.name,
      description: input.description,
      materials: "",
      archived: false,
      intervalSeconds: limits.absoluteHours ? undefined : toSeconds(hours),
      intervalCycles: limits.absoluteCycles ? undefined : cycles,
      intervalLandings: limits.absoluteLandings ? undefined : landings,
      dueLandings: limits.absoluteLandings ? landings : undefined,
      intervalMonths:
        calendar === undefined ? undefined : toMonths(calendar, t.calendarUnit),
      dueSeconds: limits.absoluteHours ? toSeconds(hours) : undefined,
      dueCycles: limits.absoluteCycles ? cycles : undefined,
    },
  };
}

function scheduleFields({
  t,
  input,
  uuid,
  sourceKey,
  aircraftUuid,
}: Activation) {
  return {
    uuid,
    version: 0,
    sourceKey,
    aircraftUuid,
    manualReference: t.manualReference,
    lastSeconds: input.lastSeconds,
    lastCycles: input.lastCycles,
    lastLandings: input.lastLandings,
    lastDate: input.lastDate,
  };
}

function createTaskCards(
  next: Snapshot,
  { t, sourceKey, aircraftUuid }: Activation,
  links: {
    inspectionUuid: string;
    componentUuid: string;
    requirementUuid: string;
  },
) {
  return t.tasks.map((task, index) =>
    saveTaskCard(next, {
      action: "save",
      uuid: crypto.randomUUID(),
      version: 0,
      fields: {
        ...taskCardDefaults(aircraftUuid),
        sourceKey: `${sourceKey}:task:${index}`,
        title: `${t.name} — ${task.itemCode || index + 1}`,
        cardNumber: "",
        description: task.instruction,
        itemCode: task.itemCode,
        applicability: taskApplicabilityText(task),
        maintenanceReference: taskSourceText(task),
        manualReference: task.manualReference,
        ...links,
        steps: [],
      },
    }),
  );
}

function dueAfter(
  limit: number | undefined,
  last: number | undefined,
  absolute: boolean,
  round = (sum: number) => sum,
) {
  if (limit === undefined || absolute) return limit;
  return last === undefined ? undefined : round(last + limit);
}

function readCalendarDue(
  t: InspectionTemplate,
  interval: number | undefined,
  lastDate: string | undefined,
) {
  if (interval === undefined || !lastDate) return undefined;
  try {
    return t.applicability.kind === "component"
      ? calendarDue(lastDate, interval, t.calendarUnit)
      : endOfDueMonth(lastDate, toMonths(interval, t.calendarUnit));
  } catch (error) {
    // A date still being typed, or one past the calendar's range, has no due
    // date yet.
    if (
      error instanceof Rejection ||
      error instanceof z.ZodError ||
      error instanceof RangeError
    )
      return undefined;
    throw error;
  }
}

function toMonths(value: number, unit: InspectionTemplate["calendarUnit"]) {
  return value * (unit === "YEARS" ? MONTHS_PER_YEAR : 1);
}

function limitMode(absolute: boolean) {
  return absolute ? ("ABSOLUTE" as const) : ("FROM_LAST_COMPLIED" as const);
}

function toSeconds(hours: number | undefined) {
  return hours === undefined ? undefined : Math.round(hours * HOUR_SECONDS);
}
