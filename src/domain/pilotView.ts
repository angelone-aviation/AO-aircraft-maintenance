import type { Snapshot } from "./model";
import { programPermission } from "./programs";
export function isPilotView(s: Snapshot) {
  return (
    programPermission(s, "flight") &&
    !programPermission(s, "admin") &&
    !programPermission(s, "maintenance") &&
    !programPermission(s, "resolve")
  );
}
export const pilotNavigation = new Set([
  "/",
  "/flight-plans",
  "/checklists",
  "/flights",
  "/discrepancies",
  "/manuals",
  "/sync",
]);
