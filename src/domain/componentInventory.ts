import type { Snapshot } from "./model";
import type { Component } from "./components";
import { activeProgram, recordProgram } from "./programs";
export function componentStorage(s: Snapshot, c: Component) {
  const location = s.management?.find(
    (r) => r.kind === "location" && r.uuid === c.locationUuid,
  );
  const name =
    location?.kind === "location"
      ? location.name
      : s.partsInventory?.locations.find((l) => l.uuid === c.locationUuid)
          ?.name;
  const label =
    name ?? (c.locationUuid ? "Location unavailable" : "Unassigned location");
  return c.partsLocation ? `${label} · ${c.partsLocation}` : label;
}
export function validateComponentLocation(s: Snapshot, c: Component) {
  if (c.outForRepair && c.installed)
    throw Error("A component out for repair cannot be installed.");
  if (!c.locationUuid) return;
  if (c.installed)
    throw new Error("Installed components cannot have an inventory location.");
  const location = s.management?.find(
    (r) => r.kind === "location" && r.uuid === c.locationUuid,
  );
  const owner =
    c.programUuid ??
    (c.aircraftUuid
      ? s.aircraft.find((a) => a.uuid === c.aircraftUuid)?.programUuid
      : activeProgram(s));
  if (!location || recordProgram(s, location) !== owner)
    throw new Error(
      "Select an inventory location in this component’s Flight Program.",
    );
}
