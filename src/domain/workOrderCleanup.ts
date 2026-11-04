/**
 * Responsibility: Removes the retired work-order authorization fields from
 *   stored work orders and cached snapshots.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types).
 *
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
 * A stored work order without the retired fields.
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
 * The retired fields a stored work order still holds, for the change-log row
 * that records their removal.
 *
 * @param value - A parsed work-order payload.
 * @returns Those keys with their values; no others.
 */
export function retiredWorkOrderFields(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => RETIRED_FIELDS.includes(key)),
  );
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
