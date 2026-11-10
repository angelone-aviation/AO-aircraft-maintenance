/**
 * Responsibility: Turns an aircraft status into the one-line OK-to-fly
 *   verdict and the single reason most worth reading first.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/aircraftStatus.ts (status, levels, reasons).
 *
 * This adds no rule: "not OK to fly" is exactly the grounded level that the
 * dispatch gate refuses; due soon and setup incomplete stay OK. It only
 * picks which of the status's own reasons to name.
 */
import type {
  AircraftStatusReason,
  ShownAircraftStatus,
  ShownStatusLevel,
} from "./aircraftStatus";

// Setup gaps only appear on a setup-incomplete aircraft, where they explain
// the level. Then a deliberate grounding by a person, a known defect on the
// airframe, an expired MEL deferral, then scheduled maintenance.
const REASON_PRIORITY: readonly AircraftStatusReason["kind"][] = [
  "setup",
  "profile",
  "discrepancy",
  "deferral",
  "inspection",
  "ad",
  "component",
];

/** The OK-to-fly verdict for one aircraft. */
export interface FlightReadiness {
  /** False exactly when the dispatch gate would refuse a flight. */
  ok: boolean;
  level: ShownStatusLevel;
  /** The reason to show first; undefined when airworthy. */
  reason?: string;
  /** How many other reasons the status holds at the same level. */
  more: number;
}

/**
 * Gives an aircraft's OK-to-fly verdict and its most important reason.
 *
 * @param status - The aircraft's status as shown, from `shownAircraftStatus`.
 * @returns Not OK only when grounded. The reason is the status reason whose
 *   kind comes first in the order setup, profile, discrepancy, deferral,
 *   inspection, AD, component; ties keep the status's own order.
 */
export function flightReadiness(status: ShownAircraftStatus): FlightReadiness {
  const [first] = [...status.reasons].sort(
    (x, y) => REASON_PRIORITY.indexOf(x.kind) - REASON_PRIORITY.indexOf(y.kind),
  );
  return {
    ok: status.level !== "grounded",
    level: status.level,
    reason: first?.label,
    more: Math.max(0, status.reasons.length - 1),
  };
}
