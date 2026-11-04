/**
 * Responsibility: Decides when the app shows the reduced pilot view and which
 *   routes that view keeps.
 * Layer: Domain. Pure functions and data; no I/O, no React.
 * Dependencies: ./model (types), ./programs (program permissions).
 */
import type { Snapshot } from "./model";
import { programPermission } from "./programs";

/**
 * Tells whether the user only flies in the active program: they may log
 * flights there, but hold no admin, maintenance or resolve permission in it.
 * Permissions in other programs do not count.
 *
 * @param s - The snapshot, with the user and their groups.
 * @returns True when the app should show the pilot view.
 */
export function isPilotView(s: Snapshot) {
  return (
    programPermission(s, "flight") &&
    !programPermission(s, "admin") &&
    !programPermission(s, "maintenance") &&
    !programPermission(s, "resolve")
  );
}

/** The navigation paths the pilot view shows; it hides every other link. */
export const pilotNavigation = new Set([
  "/",
  "/flight-plans",
  "/checklists",
  "/flights",
  "/discrepancies",
  "/manuals",
  "/sync",
]);
