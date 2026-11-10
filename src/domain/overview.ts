/**
 * Responsibility: Decides which Overview sections a member sees, and in what
 *   order, from their role in the active Flight Program.
 * Layer: Domain. Pure function and data; no I/O, no React.
 * Dependencies: ./model (types), ./programs (program permissions),
 *   ./pilotView.
 *
 * Every role sees the same data; only the order differs, so each reads first
 * what their work needs. Aircraft status, AD alerts and the due counts are
 * safety information and stay in every role's list.
 */
import type { Snapshot } from "./model";
import { programPermission } from "./programs";
import { isPilotView } from "./pilotView";

/** A section of the Overview below its header. */
export type OverviewSection =
  | "inventory"
  | "kpis"
  | "fleet"
  | "adAlerts"
  | "faaRenewal"
  | "outlook"
  | "records";

const FLEET_FIRST: readonly OverviewSection[] = [
  "inventory",
  "kpis",
  "fleet",
  "adAlerts",
  "faaRenewal",
  "outlook",
  "records",
];
const DUE_FIRST: readonly OverviewSection[] = [
  "outlook",
  "adAlerts",
  "inventory",
  "kpis",
  "fleet",
  "faaRenewal",
  "records",
];
// The pilot view has never shown purchasing, FAA credential or maintenance
// planning sections (docs/user-certifications.md).
const AIRCRAFT_FIRST: readonly OverviewSection[] = [
  "fleet",
  "adAlerts",
  "kpis",
  "records",
];

/**
 * Orders the Overview for the member's role in the active program.
 *
 * @param s - The scoped snapshot.
 * @returns The sections to show, top to bottom. Administrators (and members
 *   with neither a flight-only nor a maintenance role) get the fleet summary
 *   first; a mechanic (maintenance permission) gets the maintenance outlook
 *   and AD alerts first; the pilot view gets the aircraft cards first, then
 *   AD alerts, and no inventory, FAA renewal or outlook sections.
 */
export function overviewSections(s: Snapshot): readonly OverviewSection[] {
  if (isPilotView(s)) return AIRCRAFT_FIRST;
  if (programPermission(s, "admin")) return FLEET_FIRST;
  if (programPermission(s, "maintenance")) return DUE_FIRST;
  return FLEET_FIRST;
}
