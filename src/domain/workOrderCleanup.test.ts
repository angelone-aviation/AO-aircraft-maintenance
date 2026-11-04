/**
 * Responsibility: Pins the removal of retired work-order authorization fields
 *   from orders and caches, never from the change log.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrderCleanup.ts, workOrders.ts;
 *   src/data/demo.ts and tests/fixtures/workOrders.ts (fixtures).
 */
import { it, expect } from "vitest";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { workOrderFieldsSchema } from "./workOrders";
import {
  cleanWorkOrderSnapshot,
  removeWorkOrderAuthorization,
  retiredWorkOrderFields,
} from "./workOrderCleanup";
import { demoSnapshot } from "../data/demo";
it("drops retired fields from old submissions and cached work orders but leaves cached history untouched", () => {
  const fields = {
    ...workOrderCommand().fields,
    customerApproval: "approved",
    approvedScope: "Old scope",
    estimate: "100",
    additionalWorkApproval: "Old approval",
  };
  const parsed = workOrderFieldsSchema.parse(fields);
  expect(parsed).not.toHaveProperty("customerApproval");
  expect(parsed).not.toHaveProperty("approvedScope");
  expect(parsed).not.toHaveProperty("estimate");
  expect(parsed).not.toHaveProperty("additionalWorkApproval");
  const s = demoSnapshot();
  s.audit = [
    {
      uuid: "history",
      actorId: "user",
      at: 1,
      action: "workOrder.save",
      entityUuid: "wo",
      before: JSON.stringify(fields),
      after: JSON.stringify(fields),
    },
  ];
  s.workOrders = [
    { ...(fields as unknown as NonNullable<typeof s.workOrders>[number]) },
  ];
  const history = JSON.stringify(s.audit);
  const cleaned = cleanWorkOrderSnapshot(s);
  // ADR-0005: change-log entries are never rewritten, even in a device cache.
  expect(JSON.stringify(cleaned.audit)).toBe(history);
  expect(cleaned.workOrders![0]).not.toHaveProperty("customerApproval");
  expect(cleaned.workOrders![0]).not.toHaveProperty("estimate");
  expect(cleaned.aircraft).toEqual(s.aircraft);
});

it("copies a payload without the retired fields, reports only those, and passes non-objects through", () => {
  const saved = { uuid: "wo", estimate: "100", customerApproval: "yes" };
  expect(removeWorkOrderAuthorization(saved)).toEqual({ uuid: "wo" });
  expect(saved.estimate).toBe("100");
  expect(retiredWorkOrderFields(saved)).toEqual({
    estimate: "100",
    customerApproval: "yes",
  });
  const list = [saved];
  for (const value of [null, undefined, "estimate", list])
    expect(removeWorkOrderAuthorization(value)).toBe(value);
});
