/**
 * Responsibility: Where an uninstalled component is kept: its storage label
 *   and which inventory locations it may name.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, components.ts and management.ts (types),
 *   programs.ts, rejection.ts.
 */
import type { Snapshot } from "./model";
import type { Component } from "./components";
import type { Location } from "./management";
import { activeProgram, recordProgram } from "./programs";
import { Rejection } from "./rejection";

/**
 * Describes where a component is stored, for inventory lists.
 *
 * @param s - The snapshot.
 * @param c - The component.
 * @returns The location's name, then " · " and the bin when there is one.
 *   "Unassigned location" stands in for no location, and "Location
 *   unavailable" for one the snapshot does not hold.
 */
export function componentStorage(s: Snapshot, c: Component) {
  // Only program administrators load location records; everyone else sees
  // the names through the parts-inventory summary.
  const name =
    findLocation(s, c.locationUuid)?.name ??
    s.partsInventory?.locations.find((l) => l.uuid === c.locationUuid)?.name;
  const label =
    name ?? (c.locationUuid ? "Location unavailable" : "Unassigned location");
  return c.partsLocation ? `${label} · ${c.partsLocation}` : label;
}

/**
 * Checks a component's storage against its installation before it is saved.
 *
 * @param s - The snapshot.
 * @param c - The component as it will be saved.
 * @throws {Rejection} "A component out for repair cannot be installed.";
 *   "Installed components cannot have an inventory location."; "Select an
 *   inventory location in this component’s Flight Program." for a missing
 *   location, or one outside the component's program (its own, else its
 *   aircraft's, else the active one).
 */
export function validateComponentLocation(s: Snapshot, c: Component) {
  if (c.outForRepair && c.installed)
    throw new Rejection("A component out for repair cannot be installed.");
  if (!c.locationUuid) return;
  if (c.installed)
    throw new Rejection(
      "Installed components cannot have an inventory location.",
    );
  const location = findLocation(s, c.locationUuid);
  if (!location || recordProgram(s, location) !== componentProgram(s, c))
    throw new Rejection(
      "Select an inventory location in this component’s Flight Program.",
    );
}

function findLocation(s: Snapshot, uuid: string | undefined) {
  return s.management?.find(
    (r): r is Location => r.kind === "location" && r.uuid === uuid,
  );
}

function componentProgram(s: Snapshot, c: Component) {
  return (
    c.programUuid ??
    (c.aircraftUuid
      ? s.aircraft.find((a) => a.uuid === c.aircraftUuid)?.programUuid
      : activeProgram(s))
  );
}
