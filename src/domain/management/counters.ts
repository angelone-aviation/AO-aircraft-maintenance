/**
 * Responsibility: The usage an inspection is measured against, and the check
 *   that corrected aircraft totals stay after recorded maintenance.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ../components, ../model, ../rejection, ./schemas.
 */
import {
  componentAircraftSeconds,
  componentTotals,
  tracking,
  type Component,
} from "../components";
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
 * @returns Seconds, cycles and the aircraft's landings.
 * @throws {Rejection} "Inspection component not found." when the component
 *   is not on this aircraft; as {@link componentAircraftSeconds} and
 *   {@link componentTotals}.
 */
export function inspectionCounters(
  i: Inspection,
  a: Aircraft,
  records: ManagedRecord[] = [],
  today = localDate(),
) {
  if (!i.componentUuid)
    return {
      seconds: componentAircraftSeconds(i, a),
      cycles: a.cycles,
      landings: a.landings,
    };
  const c = records.find(
    (r): r is Component =>
      r.kind === "component" &&
      r.uuid === i.componentUuid &&
      r.aircraftUuid === a.uuid,
  );
  if (!c) throw new Rejection("Inspection component not found.");
  const totals = componentTotals(c, a, today);
  return {
    seconds: totals.timeSinceNew,
    cycles: totals.cyclesSinceNew,
    landings: a.landings,
  };
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
    counters.seconds < (i.lastSeconds ?? 0) ||
    counters.cycles < (i.lastCycles ?? 0) ||
    a.landings < (i.lastLandings ?? 0)
  );
}
