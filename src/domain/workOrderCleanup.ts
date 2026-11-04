/**
 * Responsibility: Removes the retired work-order authorization fields from
 *   snapshots cached on devices.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types).
 *
 * A device may still hold a snapshot from a build that wrote them; the server
 * never stored them after the fresh start (docs/architecture/t21-inventory.md).
 * Only work orders lose them: change-log rows keep the fields, because
 * history is never rewritten (ADR-0005).
 */
import type { Snapshot } from "./model";

const RETIRED_FIELDS: readonly string[] = [
  "customerApproval",
  "approvedScope",
  "estimate",
  "additionalWorkApproval",
];

/**
 * A cached work order without the retired fields.
 *
 * @param value - A parsed work-order payload.
 * @returns A shallow copy without the retired keys, or `value` itself when it
 *   is null, an array or not an object.
 */
export function removeWorkOrderAuthorization(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  for (const key of RETIRED_FIELDS) delete result[key];
  return result;
}

/**
 * A cached snapshot with the retired fields removed from its work orders.
 *
 * @param snapshot - The cached snapshot.
 * @returns A shallow copy; the change log and all else are left as they were.
 */
export function cleanWorkOrderSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    workOrders: snapshot.workOrders?.map(
      (order) => removeWorkOrderAuthorization(order) as typeof order,
    ),
  };
}
