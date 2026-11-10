/**
 * Responsibility: The usage an inspection is measured against, and the check
 *   that corrected aircraft totals stay after recorded maintenance.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ../components, ../maintenance, ../model, ../rejection,
 *   ./schemas.
 */
import {
  componentAircraftSeconds,
  componentTotals,
  componentTotalsWithoutTime,
  tracking,
  type Component,
} from "../components";
import { inspectionStatus } from "../maintenance";
import { localDate, type Aircraft, type Inspection } from "../model";
import { Rejection } from "../rejection";
import type { ManagedRecord } from "./schemas";

/**
 * The usage an inspection is measured against: the aircraft's, or for a
 * component inspection, the component's time and cycles since new.
 *
 * @param i - The inspection.
 * @param a - Its aircraft.
 * @param records - The program's records, to find the component.
 * @param today - The local date to measure the component on; the clock's by
 *   default.
 * @returns Seconds, cycles and the aircraft's landings. Seconds are undefined
 *   only when they cannot be read (an aircraft meter without a reading) and
 *   either the inspection is the aircraft's and has no hours limit, or its
 *   date, cycle or landing limit already makes it overdue: a reached limit
 *   decides before one that cannot be judged.
 * @throws {Rejection} "Inspection component not found." when the component
 *   is not on this aircraft; otherwise as {@link componentAircraftSeconds}
 *   and {@link componentTotals}.
 */
export function inspectionCounters(
  i: Inspection,
  a: Aircraft,
  records: ManagedRecord[] = [],
  today = localDate(),
): { seconds: number | undefined; cycles: number; landings: number } {
  const c = findInspectionComponent(i, a, records);
  try {
    return { ...readUsage(i, a, c, today), landings: a.landings };
  } catch (error) {
    const untimed =
      error instanceof Rejection && readUsageWithoutTime(i, a, c, today);
    if (!untimed) throw error;
    return untimed;
  }
}

/**
 * Checks that corrected aircraft totals do not fall before recorded work:
 * an installed component's installation, a landing-based service, or an
 * inspection's last compliance.
 *
 * @param a - The aircraft with its corrected totals.
 * @param records - The program's records.
 * @param inspections - The inspections to check; others' aircraft are skipped.
 * @throws {Rejection} "Correction would move aircraft totals before a
 *   component installation.", "… landings before recorded service
 *   compliance." or "… usage before recorded inspection compliance.", in
 *   that order; as {@link inspectionCounters}.
 */
export function validateMaintenanceTotals(
  a: Aircraft,
  records: ManagedRecord[],
  inspections: Inspection[],
) {
  if (records.some((c) => precedesInstallation(a, c)))
    throw new Rejection(
      "Correction would move aircraft totals before a component installation.",
    );
  if (records.some((r) => precedesServiceLandings(a, r)))
    throw new Rejection(
      "Correction would move landings before recorded service compliance.",
    );
  for (const i of inspections)
    if (i.aircraftUuid === a.uuid && precedesCompliance(a, i, records))
      throw new Rejection(
        "Correction would move usage before recorded inspection compliance.",
      );
}

function findInspectionComponent(
  i: Inspection,
  a: Aircraft,
  records: ManagedRecord[],
) {
  if (!i.componentUuid) return undefined;
  const c = records.find(
    (r): r is Component =>
      r.kind === "component" &&
      r.uuid === i.componentUuid &&
      r.aircraftUuid === a.uuid,
  );
  if (!c) throw new Rejection("Inspection component not found.");
  return c;
}

function readUsage(
  i: Inspection,
  a: Aircraft,
  c: Component | undefined,
  today: string,
): { seconds: number | undefined; cycles: number } {
  if (!c) return { seconds: componentAircraftSeconds(i, a), cycles: a.cycles };
  const totals = componentTotals(c, a, today);
  return { seconds: totals.timeSinceNew, cycles: totals.cyclesSinceNew };
}

// The usage left when the time cannot be read. An aircraft inspection with
// no hours limit never needed it (bug RM-66). Otherwise it stands only when
// the date, cycle or landing limit is already overdue, so a passed limit
// grounds the aircraft, while an unreadable hours limit is never taken for
// time remaining.
function readUsageWithoutTime(
  i: Inspection,
  a: Aircraft,
  c: Component | undefined,
  today: string,
) {
  const cycles = c
    ? componentTotalsWithoutTime(c, a, today).cyclesSinceNew
    : a.cycles;
  if (cycles === null) return undefined;
  const untimed = { seconds: undefined, cycles, landings: a.landings };
  if (!c && i.dueSeconds === undefined) return untimed;
  const { status } = inspectionStatus(i, a, today, untimed);
  return status === "overdue" ? untimed : undefined;
}

function precedesInstallation(a: Aircraft, c: ManagedRecord) {
  return (
    c.kind === "component" &&
    c.aircraftUuid === a.uuid &&
    c.installed &&
    ((tracking(c).time &&
      componentAircraftSeconds(c, a) < c.installedSeconds) ||
      (tracking(c).cycles && a.cycles < c.installedCycles))
  );
}

function precedesServiceLandings(a: Aircraft, r: ManagedRecord) {
  return (
    r.kind === "componentRequirement" &&
    r.aircraftUuid === a.uuid &&
    !!r.intervalLandings &&
    (!r.landingReferenceAircraftUuid ||
      r.landingReferenceAircraftUuid === a.uuid) &&
    a.landings < (r.lastLandings ?? 0)
  );
}

function precedesCompliance(
  a: Aircraft,
  i: Inspection,
  records: ManagedRecord[],
) {
  const counters = inspectionCounters(i, a, records);
  return (
    (counters.seconds !== undefined &&
      counters.seconds < (i.lastSeconds ?? 0)) ||
    counters.cycles < (i.lastCycles ?? 0) ||
    a.landings < (i.lastLandings ?? 0)
  );
}
