/**
 * Responsibility: Pins the one-off backfill that marks stock already used as
 *   flight-line oil: once, across batches, appending one change-log row per
 *   item marked and editing none.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/management.ts (backfillOilMarker), convex/schema.ts,
 *   src/domain/management.ts.
 */
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Stock } from "../src/domain/management";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const stock = (uuid: string, over: Partial<Stock> = {}): Stock => ({
  kind: "stock",
  uuid,
  version: 2,
  programUuid: "demo-program",
  locationUuid: "store",
  partNumber: uuid.toUpperCase(),
  description: uuid,
  category: "supply",
  condition: "new",
  alternates: "",
  quantity: 5,
  minimum: 0,
  ...over,
});
it("marks stock already used as flight-line oil, once, without touching existing audit rows", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const s of [
        stock("used-oil"),
        stock("marked-oil", { oil: true }),
        stock("tire", { category: "part" }),
      ])
        await ctx.db.insert("management", {
          uuid: s.uuid,
          kind: s.kind,
          programUuid: s.programUuid,
          payload: JSON.stringify(s),
        });
      const row = (entityUuid: string, action = "stock.oil_used") => ({
        uuid: crypto.randomUUID(),
        actorId: "pilot",
        at: 1,
        action,
        entityUuid,
        programUuid: "demo-program",
        aircraftUuid: "demo-206",
        before: JSON.stringify({ uuid: entityUuid, cost: 12.5 }),
        after: JSON.stringify({ uuid: entityUuid, cost: 12.5 }),
      });
      await ctx.db.insert("audit", row("used-oil"));
      await ctx.db.insert("audit", row("used-oil"));
      await ctx.db.insert("audit", row("marked-oil"));
      await ctx.db.insert("audit", row("missing-stock"));
      // Other stock activity must not mark an item as oil.
      await ctx.db.insert("audit", row("tire", "record.save"));
      // Enough unrelated history to need more than one batch.
      for (let i = 0; i < 600; i++)
        await ctx.db.insert("audit", row(`flight-${i}`, "flight.created"));
      await ctx.db.insert("audit", row("used-oil"));
    });
    const auditBefore = await t.run((ctx) => ctx.db.query("audit").collect());
    const payload = (uuid: string) =>
      t.run(
        async (ctx) =>
          JSON.parse(
            (await ctx.db
              .query("management")
              .withIndex("uuid", (q) => q.eq("uuid", uuid))
              .unique())!.payload,
          ) as Stock,
      );

    await t.mutation(internal.management.backfillOilMarker, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await payload("used-oil")).toMatchObject({ oil: true, version: 3 });
    expect(await payload("marked-oil")).toMatchObject({
      oil: true,
      version: 2,
    });
    expect((await payload("tire")).oil).toBeUndefined();

    const auditAfter = await t.run((ctx) => ctx.db.query("audit").collect());
    // Existing rows are unchanged; exactly one new row was appended.
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
    const added = auditAfter.slice(auditBefore.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      actorId: "system",
      action: "stock.oil_marker_backfill",
      entityUuid: "used-oil",
      programUuid: "demo-program",
    });
    expect(added[0].aircraftUuid).toBeUndefined();
    expect(JSON.parse(added[0].after!)).toEqual({
      stockUuid: "used-oil",
      oil: true,
    });

    // A second run changes nothing.
    const result = await t.mutation(internal.management.backfillOilMarker, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(result.marked).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("audit").collect())).toEqual(
      auditAfter,
    );
    expect(await payload("used-oil")).toMatchObject({ oil: true, version: 3 });
  } finally {
    vi.useRealTimers();
  }
});
it("reports what one batch scanned and changed", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const s = stock("used-oil");
    await ctx.db.insert("management", {
      uuid: s.uuid,
      kind: s.kind,
      programUuid: s.programUuid,
      payload: JSON.stringify(s),
    });
    await ctx.db.insert("audit", {
      uuid: "a",
      actorId: "pilot",
      at: 1,
      action: "stock.oil_used",
      entityUuid: "used-oil",
    });
  });
  expect(await t.mutation(internal.management.backfillOilMarker, {})).toEqual({
    scanned: 1,
    marked: 1,
    alreadyMarked: 0,
    missing: 0,
    isDone: true,
  });
});
