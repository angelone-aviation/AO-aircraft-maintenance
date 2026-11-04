/**
 * Responsibility: What is due in a Flight Program or on one aircraft: its
 *   inspections, component requirements and ADs, each at one level.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ./model, ./adOwnership, ./airworthiness, ./components,
 *   ./maintenance, ./management.
 *
 * The three status functions keep their own words; this module lists the
 * items they apply to, keeps what they throw and maps each status to one
 * level. Which items a screen shows, and what a throw means there, stays
 * with each caller until T13 decides their differences.
 */
import { adAircraftUuid } from "./adOwnership";
import {
  adStatus,
  adTaskStatus,
  CLOSED_APPLICABILITY,
  type AD,
  type ADTask,
} from "./airworthiness";
import {
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "./components";
import { inspectionStatus } from "./maintenance";
import { inspectionCounters } from "./management";
import {
  localDate,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "./model";

/** How pressing an item is, in one vocabulary for every kind. */
export type DueLevel = "overdue" | "due-soon" | "ok" | "unknown";

/** A status function's result, or what it threw; never both. */
type Outcome<T> =
  { due: T; error?: undefined } | { due?: undefined; error: unknown };

/**
 * An unarchived inspection of an aircraft in the snapshot. `due` is
 * {@link inspectionStatus} on {@link inspectionCounters}; when either throws,
 * `error` is what it threw and the level is unknown.
 */
export type InspectionDue = {
  kind: "inspection";
  inspection: Inspection;
  aircraft: Aircraft;
  level: DueLevel;
} & Outcome<ReturnType<typeof inspectionStatus>>;

/**
 * A requirement of a component installed on an aircraft in the snapshot, or
 * held in inventory (no `aircraft`), with {@link requirementStatus} as `due`
 * or what it threw as `error`.
 */
export type RequirementDue = {
  kind: "componentRequirement";
  requirement: ComponentRequirement;
  component: Component;
  aircraft?: Aircraft;
  level: DueLevel;
} & Outcome<ReturnType<typeof requirementStatus>>;

/**
 * An AD on the aircraft {@link adAircraftUuid} names (`aircraft` is undefined
 * when the snapshot does not hold it), with its {@link adStatus} as `status`.
 */
export interface AdDue {
  kind: "ad";
  ad: AD;
  /** The component the AD names, when the snapshot holds it. */
  component?: Component;
  aircraftUuid: string;
  aircraft?: Aircraft;
  status: string;
  level: DueLevel;
  tasks: AdTaskDue[];
}

/** One required action of an AD, with its {@link adTaskStatus}. */
export interface AdTaskDue {
  task: ADTask;
  status: ReturnType<typeof adTaskStatus>;
  level: DueLevel;
}

/** One item {@link dueItems} lists. */
export type MaintenanceDue = InspectionDue | RequirementDue | AdDue;

const INSPECTION_LEVELS: Record<
  ReturnType<typeof inspectionStatus>["status"],
  DueLevel
> = {
  overdue: "overdue",
  "due-soon": "due-soon",
  scheduled: "ok",
  unknown: "unknown",
};

// GLOSSARY "Overdue": a component usage limit at exactly 0 is "Due now".
const OVERDUE_REQUIREMENT_STATUSES = ["Past due", "Due now"];
const OK_AD_STATUSES: readonly string[] = [
  "Scheduled",
  "Complied",
  "Previously Complied With (PCW)",
  ...CLOSED_APPLICABILITY,
];

/**
 * Lists every unarchived inspection, every requirement of a component the
 * snapshot holds, and every AD, each with its status on `today`.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - Only this aircraft's items; undefined for the whole
 *   Flight Program, with components held in inventory and ADs whose aircraft
 *   the snapshot does not hold.
 * @param today - A local date; today by default.
 * @returns Inspections, then requirements, then ADs, each in record order.
 *   ADs that no longer apply are listed too, at level ok.
 */
export function dueItems(
  s: Snapshot,
  aircraftUuid?: string,
  today = localDate(),
): MaintenanceDue[] {
  const isListed = (uuid: string | undefined) =>
    aircraftUuid === undefined || uuid === aircraftUuid;
  return [
    ...listInspections(s, isListed, today),
    ...listRequirements(s, isListed, today),
    ...listADs(s, isListed, today),
  ];
}

/**
 * The level of an AD's status or one of its actions'.
 *
 * @param status - An {@link adStatus} or {@link adTaskStatus}.
 * @returns Overdue and Due soon as such; ok for Scheduled, Complied, PCW and
 *   a closed applicability; else unknown, as "Due not set", "Counter
 *   unavailable", "Needs review" and "Removed component" cannot be judged.
 */
export function adLevel(status: string): DueLevel {
  if (status === "Overdue") return "overdue";
  if (status === "Due soon") return "due-soon";
  return OK_AD_STATUSES.includes(status) ? "ok" : "unknown";
}

type Listed = (aircraftUuid: string | undefined) => boolean;

function listInspections(
  s: Snapshot,
  isListed: Listed,
  today: string,
): InspectionDue[] {
  return s.inspections.flatMap((i) => {
    if (i.archived || !isListed(i.aircraftUuid)) return [];
    const a = s.aircraft.find((x) => x.uuid === i.aircraftUuid);
    if (!a) return [];
    const outcome = measureInspection(s, i, a, today);
    return [{ kind: "inspection", inspection: i, aircraft: a, ...outcome }];
  });
}

// Each caller decides what an uncomputable status means (review, skip, a
// flag or a failure), so what was thrown is kept, not handled, here.
function measureInspection(
  s: Snapshot,
  i: Inspection,
  a: Aircraft,
  today: string,
) {
  try {
    const counters = inspectionCounters(i, a, s.management, today);
    const due = inspectionStatus(i, a, today, counters);
    return { due, level: INSPECTION_LEVELS[due.status] };
  } catch (error) {
    return { error, level: "unknown" as const };
  }
}

function listRequirements(
  s: Snapshot,
  isListed: Listed,
  today: string,
): RequirementDue[] {
  const records = s.management ?? [];
  return records.flatMap((r) => {
    if (r.kind !== "componentRequirement") return [];
    const c = findComponent(s, r.componentUuid);
    if (!c) return [];
    const a = c.installed
      ? s.aircraft.find((x) => x.uuid === c.aircraftUuid)
      : undefined;
    if ((c.installed && !a) || !isListed(a?.uuid)) return [];
    const outcome = measureRequirement(r, c, a, today);
    const item = { requirement: r, component: c, aircraft: a, ...outcome };
    return [{ kind: "componentRequirement", ...item }];
  });
}

function measureRequirement(
  r: ComponentRequirement,
  c: Component,
  a: Aircraft | undefined,
  today: string,
) {
  try {
    const due = requirementStatus(r, c, a, today);
    return { due, level: requirementLevel(due.status) };
  } catch (error) {
    return { error, level: "unknown" as const };
  }
}

function listADs(s: Snapshot, isListed: Listed, today: string): AdDue[] {
  return (s.airworthiness ?? []).flatMap((r) => {
    const aircraftUuid = adAircraftUuid(s, r);
    if (!isListed(aircraftUuid)) return [];
    const status = adStatus(s, r, today);
    const tasks = r.tasks.map((task) => {
      const taskStatus = adTaskStatus(s, r, task, today);
      return { task, status: taskStatus, level: adLevel(taskStatus) };
    });
    return [
      {
        kind: "ad",
        ad: r,
        component: findComponent(s, r.componentUuid),
        aircraftUuid,
        aircraft: s.aircraft.find((x) => x.uuid === aircraftUuid),
        status,
        level: adLevel(status),
        tasks,
      },
    ];
  });
}

function findComponent(s: Snapshot, uuid: string) {
  return s.management?.find(
    (x): x is Component => x.kind === "component" && x.uuid === uuid,
  );
}

// "Set landing baseline" and "Set time baseline" cannot be judged yet.
function requirementLevel(status: string): DueLevel {
  if (OVERDUE_REQUIREMENT_STATUSES.includes(status)) return "overdue";
  if (status === "Due soon") return "due-soon";
  return status === "Tracked" ? "ok" : "unknown";
}
