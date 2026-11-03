import type { Snapshot } from "./model";
import type { AD } from "./airworthiness";
export function adAircraftUuid(s: Pick<Snapshot, "management">, r: AD) {
  const c = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r.componentUuid,
  );
  return c?.kind === "component" && c.installed && c.aircraftUuid
    ? c.aircraftUuid
    : r.aircraftUuid;
}
