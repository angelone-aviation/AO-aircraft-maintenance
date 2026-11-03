import "fake-indexeddb/auto";
import { openDB } from "idb";
import { it, expect } from "vitest";
import { readSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import { saveWorkOrder } from "../domain/workOrders";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
it("upgrades all cached namespaces, deletes authorization fields from cached orders, and keeps cached history as written", async () => {
  const oldDb = await openDB("angel-one-v1", 1, {
    upgrade(db) {
      db.createObjectStore("snapshots");
      db.createObjectStore("outbox");
      db.createObjectStore("settings");
    },
  });
  const s = demoSnapshot();
  const order = saveWorkOrder(s, workOrderCommand());
  const legacy = {
    ...order,
    customerApproval: "approved",
    approvedScope: "Old",
    estimate: "100 USD",
    additionalWorkApproval: "Old",
  };
  s.workOrders = [legacy];
  s.audit = [
    {
      uuid: "audit",
      at: 1,
      actorId: "user",
      action: "workOrder.save",
      entityUuid: order.uuid,
      after: JSON.stringify(legacy),
    },
  ];
  await oldDb.put("snapshots", s, "demo");
  await oldDb.put("snapshots", s, "demo:all");
  oldDb.close();
  expect((await readSnapshot("demo"))?.workOrders?.[0]).toEqual(order);
  const upgraded = await openDB("angel-one-v1", 2);
  for (const key of ["demo", "demo:all"]) {
    const cached = await upgraded.get("snapshots", key);
    expect(cached.workOrders[0]).toEqual(order);
    // ADR-0005: change-log entries are never rewritten, even in a device cache.
    expect(JSON.parse(cached.audit[0].after)).toEqual(legacy);
  }
  upgraded.close();
});
