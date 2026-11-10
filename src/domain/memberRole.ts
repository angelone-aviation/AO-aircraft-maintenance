/**
 * Responsibility: The one-line role a member is shown under, in the sidebar
 *   profile and in Settings.
 * Layer: Domain. Pure function; no I/O, no React.
 * Dependencies: ./model (types), ./programs, ./pilotView, ./ownerView,
 *   ./boardView.
 */
import type { Snapshot } from "./model";
import { programPermission } from "./programs";
import { isPilotView } from "./pilotView";
import { isOwnerView } from "./ownerView";
import { isBoardView } from "./boardView";

/**
 * Names what the signed-in member is in the active Flight Program, in the
 * glossary's terms; a description only, never a permission check.
 *
 * @param s - The scoped snapshot.
 * @returns "System administrator", "Flight Program administrator", "Aircraft
 *   owner", "Board member", "Mechanic" (maintenance permission), "Pilot" (the
 *   pilot view) or "Member", the first that applies.
 */
export function memberRoleLabel(s: Snapshot) {
  if (s.user.isAdmin) return "System administrator";
  if (programPermission(s, "admin")) return "Flight Program administrator";
  if (isOwnerView(s)) return "Aircraft owner";
  if (isBoardView(s)) return "Board member";
  if (programPermission(s, "maintenance")) return "Mechanic";
  return isPilotView(s) ? "Pilot" : "Member";
}
