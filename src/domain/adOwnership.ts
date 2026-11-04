/**
 * Responsibility: Which aircraft an airworthiness directive applies to now.
 * Layer: Domain. Pure function; no I/O, no React.
 * Dependencies: src/domain/model.ts, airworthiness.ts (types).
 *
 * Kept out of airworthiness.ts, which re-exports it, so modules that
 * airworthiness.ts imports can use it without an import cycle.
 */
import type { Snapshot } from "./model";
import type { AD } from "./airworthiness";

/**
 * The aircraft an AD applies to: a component AD follows its component while
 * the component is installed on an aircraft, and otherwise stays with the
 * aircraft the AD names.
 *
 * @param s - The snapshot's tracked records.
 * @param r - The AD.
 * @returns The installed component's aircraft uuid, else `r.aircraftUuid`.
 */
export function adAircraftUuid(s: Pick<Snapshot, "management">, r: AD) {
  const c = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r.componentUuid,
  );
  return c?.kind === "component" && c.installed && c.aircraftUuid
    ? c.aircraftUuid
    : r.aircraftUuid;
}
