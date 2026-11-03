import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

it("appends a hand-written entry for a direct production edit, named to a system administrator", async () => {
  const t = convexTest(schema, modules);
  const { admin, existing } = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "Technical owner",
      email: "owner@example.test",
      groupIds: [],
    });
    await ctx.db.insert("users", {
      active: true,
      isAdmin: false,
      name: "Mechanic",
      email: "mechanic@example.test",
      groupIds: [],
    });
    await ctx.db.insert("users", {
      active: false,
      isAdmin: true,
      name: "Former owner",
      email: "former@example.test",
      groupIds: [],
    });
    const existing = await ctx.db.insert("audit", {
      uuid: crypto.randomUUID(),
      actorId: admin,
      at: 1,
      action: "ad.save",
      entityUuid: "ad-1",
    });
    return { admin, existing };
  });
  const entry = {
    actorEmail: " Owner@Example.test ",
    reason: "Restore of 2026-11-02 snapshot after a failed deploy",
    description:
      "Replaced the airworthiness row for AD 2026-01-01 from backup.",
    entityUuid: "ad-1",
    aircraftUuid: "demo-206",
    before: { dueHours: 2300 },
    after: { dueHours: 2440 },
  };
  for (const actorEmail of [
    "mechanic@example.test",
    "former@example.test",
    "nobody@example.test",
  ])
    await expect(
      t.mutation(internal.audit.recordManualEntry, { ...entry, actorEmail }),
    ).rejects.toThrow("system administrator");
  await expect(
    t.mutation(internal.audit.recordManualEntry, { ...entry, reason: "  " }),
  ).rejects.toThrow("reason");
  await expect(
    t.mutation(internal.audit.recordManualEntry, {
      ...entry,
      description: "",
    }),
  ).rejects.toThrow("description");
  const before = await t.run((ctx) => ctx.db.get(existing));
  await t.mutation(internal.audit.recordManualEntry, entry);
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(rows).toHaveLength(2);
  // Existing entries are never touched.
  expect(await t.run((ctx) => ctx.db.get(existing))).toEqual(before);
  const written = rows.find((r) => r._id !== existing)!;
  expect(written).toMatchObject({
    actorId: admin,
    action: "audit.manual_entry",
    entityUuid: "ad-1",
    aircraftUuid: "demo-206",
    reason: entry.reason,
  });
  expect(JSON.parse(written.before!)).toEqual({ dueHours: 2300 });
  expect(JSON.parse(written.after!)).toEqual({
    description: entry.description,
    values: { dueHours: 2440 },
  });
});
