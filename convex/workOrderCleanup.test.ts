/**
 * Responsibility: Pins the retired-field migration: what it strips, the one
 *   entry it appends per changed order, untouched history, and idempotence.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/workOrderCleanup.ts, convex/schema.ts.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("purges retired authorization fields from saved orders, appends one entry per changed order, never edits history, and is idempotent", async () => {
  const t = convexTest(schema, modules);
  const old = {
    uuid: "wo",
    scope: "Inspection",
    status: "completed",
    customerApproval: "approved",
    approvedScope: "Remove",
    estimate: "100 USD",
    additionalWorkApproval: "Remove",
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("workOrders", {
      uuid: "wo",
      aircraftUuid: "plane",
      payload: JSON.stringify(old),
    });
    await ctx.db.insert("workOrders", {
      uuid: "clean",
      aircraftUuid: "plane",
      payload: JSON.stringify({ uuid: "clean", scope: "Annual" }),
    });
    await ctx.db.insert("audit", {
      uuid: "a",
      at: 1,
      actorId: "user",
      action: "workOrder.save",
      entityUuid: "wo",
      aircraftUuid: "plane",
      before: JSON.stringify(old),
      after: JSON.stringify(old),
    });
    await ctx.db.insert("audit", {
      uuid: "b",
      at: 1,
      actorId: "user",
      action: "stock.save",
      entityUuid: "stock",
      after: JSON.stringify({ estimate: "Keep unrelated data" }),
    });
  });
  const history = await t.run((ctx) => ctx.db.query("audit").collect());
  const migration = makeFunctionReference<"mutation">(
    "workOrderCleanup:removeAuthorization",
  );
  expect(await t.mutation(migration, {})).toEqual({
    ordersChecked: 2,
    ordersChanged: 1,
  });
  await t.run(async (ctx) => {
    const order = (await ctx.db.query("workOrders").collect())[0];
    expect(JSON.parse(order.payload)).toEqual({
      uuid: "wo",
      scope: "Inspection",
      status: "completed",
    });
    const audit = await ctx.db.query("audit").collect();
    // Existing rows are byte-identical; one correction entry is appended.
    expect(audit.slice(0, history.length)).toEqual(history);
    expect(audit).toHaveLength(history.length + 1);
    const added = audit.at(-1)!;
    expect(added).toMatchObject({
      action: "workOrder.retiredFieldsRemoved",
      entityUuid: "wo",
      aircraftUuid: "plane",
    });
    expect(JSON.parse(added.before!)).toEqual({
      customerApproval: "approved",
      approvedScope: "Remove",
      estimate: "100 USD",
      additionalWorkApproval: "Remove",
    });
    expect(added.reason).toMatch(/retired/i);
    expect(added.actorId).toBe("system:migration");
  });
  expect(await t.mutation(migration, {})).toEqual({
    ordersChecked: 2,
    ordersChanged: 0,
  });
  expect(await t.run((ctx) => ctx.db.query("audit").collect())).toHaveLength(
    history.length + 1,
  );
});
