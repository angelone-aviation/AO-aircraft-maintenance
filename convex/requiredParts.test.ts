/**
 * Responsibility: Pins the parts a problem report or inspection needs: saved
 *   and audited on the server (the change-log row as stored), with
 *   maintenance access to the aircraft only, and the stock snapshot without
 *   private vendor details.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (operations, management, schema),
 *   tests/fixtures/requiredParts.ts.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { partsFixture, neededPart } from "../tests/fixtures/requiredParts";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
it("persists linked parts and audits changes while enforcing aircraft and stock permissions", async () => {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    const s = partsFixture();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    for (const p of s.programs!) await ctx.db.insert("programs", p);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    for (const d of s.discrepancies) await ctx.db.insert("discrepancies", d);
    for (const r of s.management!)
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        programUuid: r.programUuid,
        payload: JSON.stringify(r),
      });
    const makeUser = async (permissions: ("read" | "maintenance")[]) => {
      const group = await ctx.db.insert("groups", {
        name: "Parts planner",
        programUuid: "demo-program",
        permissions,
        aircraftIds: [s.aircraft[0].uuid],
      });
      const user = await ctx.db.insert("users", {
        name: "Planner",
        active: true,
        isAdmin: false,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + DAY_MS,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      tech: await makeUser(["read", "maintenance"]),
      reader: await makeUser(["read"]),
    };
  });
  const tech = t.withIdentity(identities.tech),
    reader = t.withIdentity(identities.reader);
  const input = {
    uuid: "parts-report",
    version: 0,
    programUuid: "demo-program",
    payload: JSON.stringify([neededPart]),
  };
  await expect(
    reader.mutation(api.operations.saveDiscrepancyParts, input),
  ).rejects.toThrow("Permission");
  const report = () =>
    t.run((ctx) =>
      ctx.db
        .query("discrepancies")
        .withIndex("uuid", (q) => q.eq("uuid", input.uuid))
        .unique(),
    );
  const stored = await report();
  await tech.mutation(api.operations.saveDiscrepancyParts, input);
  // The row has always held the document, system fields too, before and
  // after, and no program.
  const rows = await t.run(async (ctx) =>
    (await ctx.db.query("audit").collect()).filter(
      (r) => r.action === "discrepancy.parts",
    ),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actorId: identities.tech.subject.split("|")[0],
    entityUuid: input.uuid,
    aircraftUuid: stored!.aircraftUuid,
    reason: "Required parts updated",
  });
  expect(rows[0]).not.toHaveProperty("programUuid");
  expect(JSON.parse(rows[0].before!)).toEqual(stored);
  expect(JSON.parse(rows[0].after!)).toEqual(await report());
  await expect(
    tech.mutation(api.operations.saveDiscrepancyParts, input),
  ).rejects.toThrow("changed");
  const s = await reader.query(api.operations.snapshot, {});
  expect(s!.discrepancies[0].requiredParts).toEqual([neededPart]);
  expect(s!.partsInventory!.stock[0].quantity).toBe(2);
  expect(s!.audit.some((a) => a.action === "discrepancy.parts")).toBe(true);
  expect(JSON.stringify(s!.partsInventory)).not.toContain("Private vendor");
  const i = s!.inspections[0];
  await tech.mutation(api.management.execute, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "inspection.save",
      record: {
        ...i,
        version: i.version ?? 0,
        materials: "",
        archived: false,
        requiredParts: [neededPart],
      },
      requestUuid: crypto.randomUUID(),
      reason: "Parts planning",
    }),
  });
  const after = await tech.query(api.operations.snapshot, {});
  expect(
    after!.inspections.find((r) => r.uuid === i.uuid)!.requiredParts,
  ).toEqual([neededPart]);
});
