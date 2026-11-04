/**
 * Responsibility: Turning a reviewed inspection template into a schedule on
 *   one aircraft or component, with draft task cards for its tasks.
 * Layer: Domain. Zod schema, rules and one applier; no I/O, no React.
 * Dependencies: zod, ./inspectionTemplates, ./model, ./programs,
 *   ./manualDiscovery, ./management, ./taskCards, ./rejection.
 */
import { z } from "zod";
import {
  taskSourceText,
  taskApplicabilityText,
  type InspectionTemplate,
} from "./inspectionTemplates";
import { can, type Snapshot } from "./model";
import { ownsActive } from "./programs";
import { matchesAircraft, matchesComponent } from "./manualDiscovery";
import { applyManagement } from "./management";
import { saveTaskCard, taskCardDefaults } from "./taskCards";
import { Rejection } from "./rejection";

const HOUR_SECONDS = 3600;
const MONTHS_PER_YEAR = 12;
// The warning window given to a component requirement made from a template:
// one month, ten hours or ten cycles before it falls due.
const REQUIREMENT_WARNING_MONTHS = 1;
const REQUIREMENT_WARNING_SECONDS = 10 * HOUR_SECONDS;
const REQUIREMENT_WARNING_CYCLES = 10;

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
  description: z.string().trim().min(1).max(2000),
  lastSeconds: count.optional(),
  lastCycles: count.optional(),
  lastLandings: count.optional(),
  lastDate: z.iso.date().optional(),
  reviewed: z.literal(true),
});

/** A request to schedule a template. */
export type ActivateTemplateInput = z.infer<typeof activateTemplateSchema>;

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
  const sourceKey = `template:${t.uuid}:${input.mode}`;
  assertNotActivated(s, sourceKey, aircraftUuid, input.targetUuid);
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
  limits: ReturnType<typeof readScheduleLimits>;
  uuid: string;
  sourceKey: string;
  aircraftUuid: string;
}

function findActivatableTemplate(s: Snapshot, input: ActivateTemplateInput) {
  const t = s.inspectionTemplates?.find((t) => t.uuid === input.templateUuid);
  if (!t || !ownsActive(s, t.programUuid))
    throw new Rejection("Template is unavailable in this Flight Program.");
  if (t.archived || t.version !== input.templateVersion)
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

// An initial schedule uses the template's first-time thresholds, always as
// absolute limits and without a calendar limit.
function readScheduleLimits(t: InspectionTemplate, initial: boolean) {
  const hours = initial ? t.initialHours : t.hours,
    cycles = initial ? t.initialCycles : t.cycles,
    landings = initial ? t.initialLandings : t.landings,
    calendar = initial ? undefined : t.calendarValue;
  if (
    hours === undefined &&
    cycles === undefined &&
    landings === undefined &&
    calendar === undefined
  )
    throw new Rejection(
      "This schedule has no numeric limits. Add verified intervals to the template first.",
    );
  return {
    hours,
    cycles,
    landings,
    calendar,
    absoluteHours: initial || t.hourMode === "ABSOLUTE",
    absoluteCycles: initial || t.cycleMode === "ABSOLUTE",
    absoluteLandings: initial || t.landingMode === "ABSOLUTE",
  };
}

function assertNotActivated(
  s: Snapshot,
  sourceKey: string,
  aircraftUuid: string,
  targetUuid: string,
) {
  if (
    s.inspections.some(
      (i) => i.sourceKey === sourceKey && i.aircraftUuid === aircraftUuid,
    ) ||
    s.management?.some(
      (r) =>
        r.kind === "componentRequirement" &&
        r.sourceKey === sourceKey &&
        r.componentUuid === targetUuid,
    )
  )
    throw new Rejection(
      "This template schedule already exists for the selected target. Open the existing record to edit it.",
    );
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
      warningCalendarMonths: REQUIREMENT_WARNING_MONTHS,
      warningSeconds: REQUIREMENT_WARNING_SECONDS,
      warningCycles: REQUIREMENT_WARNING_CYCLES,
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
        calendar === undefined
          ? undefined
          : calendar * (t.calendarUnit === "YEARS" ? MONTHS_PER_YEAR : 1),
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

function limitMode(absolute: boolean) {
  return absolute ? ("ABSOLUTE" as const) : ("FROM_LAST_COMPLIED" as const);
}

function toSeconds(hours: number | undefined) {
  return hours === undefined ? undefined : Math.round(hours * HOUR_SECONDS);
}
