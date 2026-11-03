import type { Snapshot } from "./model";

const RETIRED = [
  "customerApproval",
  "approvedScope",
  "estimate",
  "additionalWorkApproval",
];
// These fields were removed from work orders. Change-log entries keep them:
// history is never rewritten (ADR-0005).
export function removeWorkOrderAuthorization(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  for (const key of RETIRED) delete result[key];
  return result;
}
export function retiredWorkOrderFields(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => RETIRED.includes(key)),
  );
}
export function cleanWorkOrderSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    workOrders: snapshot.workOrders?.map(
      (order) => removeWorkOrderAuthorization(order) as typeof order,
    ),
  };
}
