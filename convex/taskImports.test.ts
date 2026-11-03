import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { emptyTemplate } from "../src/domain/inspectionTemplates";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("atomically persists file tasks to templates and inspections with server access checks", async () => {
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
  await expect(
    t.withIdentity(ids.reader).mutation(api.taskImports.save, args(input)),
  ).rejects.toThrow("access");
  await t.withIdentity(ids.tech).mutation(api.taskImports.save, args(input));
  let state = await t.withIdentity(ids.reader).query(api.operations.snapshot);
  expect(state!.inspectionTemplates![0].tasks).toHaveLength(2);
  expect(state!.taskCards).toHaveLength(0);
  const inspection = {
    ...input,
    targetKind: "inspection",
    targetUuid: "demo-insp-1",
    targetVersion: 0,
  };
  await t
    .withIdentity(ids.tech)
    .mutation(api.taskImports.save, args(inspection));
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
  expect(state!.taskCards![0]).toMatchObject({
    inspectionUuid: "demo-insp-1",
    itemCode: "A1",
    status: "draft",
    technicianSignoff: null,
  });
});
