/**
 * Responsibility: Pins task file imports on the server: into a template or as
 *   draft job cards with their derived columns, access checks, all-or-none
 *   refusals, and replayed request ids.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/taskImports, convex/schema,
 *   src/domain/inspectionTemplates, src/data/demo and
 *   tests/fixtures/derivedColumns (fixtures).
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { emptyTemplate } from "../src/domain/inspectionTemplates";
import { expectDerivedColumns } from "../tests/fixtures/derivedColumns";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
// A template at version 1 in the demo program, a technician (maintenance) and
// a reader, and a reviewed two-task CSV import into the template.
async function setup() {
  const t = convexTest(schema, modules);
  const template = {
    ...emptyTemplate(),
    name: "Phase 2",
    hours: 100,
    version: 1,
    programUuid: "demo-program",
    applicability: {
      kind: "aircraft",
      manufacturer: "Cessna",
      model: "441",
      partNumber: "",
    },
  };
  const ids = await t.run(async (ctx) => {
    const s = demoSnapshot();
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    await ctx.db.insert("inspectionTemplates", {
      uuid: template.uuid,
      programUuid: "demo-program",
      payload: JSON.stringify(template),
    });
    const user = async (maintenance: boolean) => {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: "Tasks",
        aircraftIds: [],
        permissions: maintenance ? ["read", "maintenance"] : ["read"],
      });
      const u = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: u,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${u}|${session}` };
    };
    return { tech: await user(true), reader: await user(false) };
  });
  const csv =
    "Item code,Task,Zone,Manual reference,PDF page\nA1,Inspect seal,131,5-12-02 page 1,79\nA2,Check vents,132,5-12-02 page 2,80";
  const input = {
    csv,
    targetKind: "template",
    targetUuid: template.uuid,
    targetVersion: 1,
    reviewed: true,
  };
  const args = (i: unknown) => ({
    programUuid: "demo-program",
    payload: JSON.stringify(i),
  });
  return { t, ids, csv, input, args };
}

it("atomically persists file tasks to templates and inspections with server access checks", async () => {
  const { t, ids, csv, input, args } = await setup();
  await expect(
    t.withIdentity(ids.reader).mutation(api.taskImports.save, args(input)),
  ).rejects.toThrow("access");
  expect(
    await t.withIdentity(ids.tech).mutation(api.taskImports.save, args(input)),
  ).toBe(2);
  let state = await t.withIdentity(ids.reader).query(api.operations.snapshot);
  expect(state!.inspectionTemplates![0].tasks).toHaveLength(2);
  expect(state!.inspectionTemplates![0].version).toBe(2);
  expect(state!.taskCards).toHaveLength(0);
  const inspection = {
    ...input,
    targetKind: "inspection",
    targetUuid: "demo-insp-1",
    targetVersion: 0,
  };
  expect(
    await t
      .withIdentity(ids.tech)
      .mutation(api.taskImports.save, args(inspection)),
  ).toBe(2);
  await expect(
    t.withIdentity(ids.tech).mutation(api.taskImports.save, args(inspection)),
  ).rejects.toThrow("already exists");
  await expect(
    t
      .withIdentity(ids.tech)
      .mutation(
        api.taskImports.save,
        args({ ...inspection, csv: csv + "\nBAD,,,,0" }),
      ),
  ).rejects.toThrow();
  state = await t.withIdentity(ids.reader).query(api.operations.snapshot);
  expect(state!.taskCards).toHaveLength(2);
  // T3: one change-log row for each imported job card.
  const rows = await t.run(async (ctx) =>
    (await ctx.db.query("audit").collect()).filter(
      (r) => r.action === "taskCard.created_from_csv",
    ),
  );
  expect(rows.map((r) => r.entityUuid).sort()).toEqual(
    state!.taskCards!.map((c) => c.uuid).sort(),
  );
  expect(state!.taskCards![0]).toMatchObject({
    inspectionUuid: "demo-insp-1",
    itemCode: "A1",
    status: "draft",
    technicianSignoff: null,
  });
  await expectDerivedColumns(
    t,
    "taskCards",
    state!.taskCards!.map((c) => c.uuid),
  );
});

it("imports once per request id: a replay returns nothing and writes nothing", async () => {
  const { t, ids, input, args } = await setup();
  const tech = t.withIdentity(ids.tech);
  const requested = { ...args(input), requestUuid: crypto.randomUUID() };
  const stored = () =>
    t.run(async (ctx) => ({
      templates: await ctx.db.query("inspectionTemplates").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
    }));
  expect(await tech.mutation(api.taskImports.save, requested)).toBe(2);
  const saved = await stored();
  expect(saved.commandRequests).toMatchObject([
    { uuid: requested.requestUuid, payload: requested.payload },
  ]);
  // ADR-0003: a replay succeeds with no payload, where a second import of the
  // same version is refused.
  await expect(tech.mutation(api.taskImports.save, requested)).resolves.toBe(
    null,
  );
  expect(await stored()).toEqual(saved);
  await expect(
    tech.mutation(api.taskImports.save, {
      ...requested,
      payload: JSON.stringify({ ...input, targetVersion: 2 }),
    }),
  ).rejects.toMatchObject({ data: "Request identifier already used." });
});
