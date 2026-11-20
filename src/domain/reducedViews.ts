/**
 * Responsibility: The snapshot of a user whose groups in the active program
 *   all give reduced views: the owner portal, the board view, or the two
 *   side by side.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ./model, ./ownerView, ./boardView.
 *
 * Reduced-view flags never add up to the workspace. A user holding both
 * kinds of group gets each view for the aircraft its own groups cover: the
 * owner whitelist for the aircraft their owner groups name, the board
 * whitelist for the rest of what their board groups reach.
 */
import { localDate, type Snapshot } from "./model";
import { isOwnerView, ownerPortalAircraft, ownerSnapshot } from "./ownerView";
import {
  boardCostRows,
  boardSnapshot,
  boardViewAircraft,
  isBoardView,
} from "./boardView";

/**
 * Reduces a program-scoped snapshot to the reduced views the user's groups
 * give.
 *
 * @param s - A program-scoped snapshot that still holds cost records.
 * @param today - A local date for the board's cost periods; today by default.
 * @returns The owner snapshot, the board snapshot, or for a user in both
 *   views the owner snapshot of the owned aircraft joined with the board
 *   snapshot of the board's other aircraft, `boardCosts` for every aircraft
 *   the board groups reach and `offsiteBackupAt`. Undefined for a user who
 *   gets the workspace.
 */
export function reducedSnapshot(
  s: Snapshot,
  today = localDate(),
): Snapshot | undefined {
  const owner = isOwnerView(s);
  const board = isBoardView(s);
  if (owner && board) return ownerBoardSnapshot(s, today);
  if (owner) return ownerSnapshot(s);
  return board ? boardSnapshot(s, today) : undefined;
}

// An owned aircraft's records come from the owner whitelist only, so the two
// lists never hold the same record twice.
function ownerBoardSnapshot(s: Snapshot, today: string): Snapshot {
  const owned = ownerPortalAircraft(s);
  const ownedIds = new Set(owned.map((a) => a.uuid));
  const reached = boardViewAircraft(s);
  const owner = ownerSnapshot({ ...s, aircraft: owned });
  const board = boardSnapshot(
    { ...s, aircraft: reached.filter((a) => !ownedIds.has(a.uuid)) },
    today,
  );
  const rows = new Map(
    [...owner.aircraft, ...board.aircraft].map((a) => [a.uuid, a]),
  );
  return {
    ...owner,
    aircraft: s.aircraft.flatMap((a) => rows.get(a.uuid) ?? []),
    discrepancies: [...owner.discrepancies, ...board.discrepancies],
    inspections: [...owner.inspections, ...board.inspections],
    airworthiness: [
      ...(owner.airworthiness ?? []),
      ...(board.airworthiness ?? []),
    ],
    management: [...(owner.management ?? []), ...(board.management ?? [])],
    workOrders: [...(owner.workOrders ?? []), ...(board.workOrders ?? [])],
    boardCosts: boardCostRows({ ...s, aircraft: reached }, today),
    offsiteBackupAt: board.offsiteBackupAt,
  };
}
