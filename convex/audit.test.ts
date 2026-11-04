/**
 * Responsibility: Pins the hand-written change-log entry for a direct
 *   production edit: who may be named as its actor, its limits, and that it
 *   only appends.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/audit.
 */
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

async function fixture() {
  const t = convexTest(schema, modules);
  const admin = await t.run((ctx) =>
    ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      name: "Technical owner",
      email: "owner@example.test",
      groupIds: [],
    }),
  );
  const record = (fields: Partial<typeof minimal> = {}) =>
    t.mutation(internal.audit.recordManualEntry, { ...minimal, ...fields });
  const rows = () => t.run((ctx) => ctx.db.query("audit").collect());
  return { admin, record, rows };
}
const minimal = {
  actorEmail: "owner@example.test",
  reason: "Restore after a failed deploy",
  description: "Restored the deployment from the 2026-11-02 export.",
  entityUuid: undefined as string | undefined,
  before: undefined as unknown,
  after: undefined as unknown,
};

it("trims the reason and description, up to 1,500 and 10,000 characters", async () => {
  const { record, rows } = await fixture();
  await expect(record({ reason: "r".repeat(1501) })).rejects.toThrow(
    "Record the reason for the edit (up to 1,500 characters).",
  );
  await expect(record({ description: "d".repeat(10001) })).rejects.toThrow(
    "Record a description of what was changed (up to 10,000 characters).",
  );
  await record({
    reason: ` ${"r".repeat(1500)} `,
    description: ` ${"d".repeat(10000)} `,
  });
  const [row] = await rows();
  expect(row.reason).toBe("r".repeat(1500));
  expect(JSON.parse(row.after!)).toEqual({ description: "d".repeat(10000) });
});

it("refuses before or after values over 100,000 characters of JSON", async () => {
  const { record, rows } = await fixture();
  const message = "Recorded values are too large; summarize them.";
  // A string of n characters is n + 2 characters of JSON.
  await expect(record({ before: "b".repeat(99_999) })).rejects.toThrow(message);
  await expect(record({ after: "a".repeat(100_000) })).rejects.toThrow(message);
  await record({ before: "b".repeat(99_998) });
  expect(await rows()).toHaveLength(1);
});

it("names an entry about no record by a new uuid and returns it with the actor", async () => {
  const { admin, record, rows } = await fixture();
  const result = await record({ entityUuid: "  " });
  const [row] = await rows();
  expect(result).toEqual({ entityUuid: row.entityUuid, actorId: admin });
  expect(row.entityUuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(row.before).toBeUndefined();
  expect((await record()).entityUuid).not.toBe(row.entityUuid);
});
