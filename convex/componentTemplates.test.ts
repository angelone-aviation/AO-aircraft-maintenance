/**
 * Responsibility: Pins component templates on the server: program-scoped
 *   saving, setup entries added once without installing components, and
 *   refusals shown with their message.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/componentTemplates, convex/schema, src/data/demo
 *   (fixture).
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

async function setup() {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("aircraft", a);
    const userId = await ctx.db.insert("users", {
      name: "Tech",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    return { subject: `${userId}|${session}` };
  });
  const client = t.withIdentity(identity);
  const record = {
    uuid: crypto.randomUUID(),
    version: 0,
    name: "Aircraft equipment",
    make: a.make,
    model: a.model,
    rows: [
      {
        id: "1",
        parentId: "",
        componentType: "Engine",
        ataChapter: "72",
        partNumber: "P1",
        model: "Engine",
        manufacturer: "",
        installPosition: "MAIN",
      },
    ],
  };
  const save = (payload: unknown) =>
    client.mutation(api.componentTemplates.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(payload),
    });
  return { t, a, client, record, save };
}

it("persists program-scoped templates and idempotent setup entries without creating installed components", async () => {
  const { t, a, client, record, save } = await setup();
  await save(record);
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify({
      templateUuid: record.uuid,
      version: 1,
      aircraftUuid: a.uuid,
      rowIds: ["1"],
    }),
  };
  expect(await client.mutation(api.componentTemplates.apply, args)).toBe(1);
  expect(await client.mutation(api.componentTemplates.apply, args)).toBe(0);
  await expect(
    client.mutation(api.componentTemplates.apply, {
      ...args,
      programUuid: "wrong",
    }),
  ).rejects.toThrow("Program changed");
  await t.run(async (ctx) => {
    expect(await ctx.db.query("componentSetups").collect()).toHaveLength(1);
    expect(await ctx.db.query("management").collect()).toHaveLength(0);
  });
});

it("audits the stored and saved versions, and shows every refusal with its message", async () => {
  const { t, a, client, record, save } = await setup();
  await save(record);
  await save({ ...record, version: 1, name: "Renamed" });
  const saves = await t.run(async (ctx) =>
    (await ctx.db.query("audit").collect()).filter(
      (e) => e.action === "componentTemplate.save",
    ),
  );
  expect(saves.map((e) => e.before && JSON.parse(e.before).version)).toEqual([
    undefined,
    1,
  ]);
  expect(saves.map((e) => JSON.parse(e.after!).version)).toEqual([1, 2]);
  const shown = (message: string) => ({ name: "ConvexError", data: message });
  await expect(save(record)).rejects.toMatchObject(
    shown("Template changed. Reopen it."),
  );
  await expect(
    client.mutation(api.componentTemplates.save, {
      programUuid: "demo-program",
      payload: "{",
    }),
  ).rejects.toMatchObject({ name: "ConvexError" });
  await expect(
    client.mutation(api.componentTemplates.apply, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        templateUuid: record.uuid,
        version: 1,
        aircraftUuid: a.uuid,
        rowIds: ["1"],
      }),
    }),
  ).rejects.toMatchObject(shown("Template changed. Reopen the preview."));
  const foreign = crypto.randomUUID();
  await t.run((ctx) =>
    ctx.db.insert("componentTemplates", {
      uuid: foreign,
      programUuid: "other-program",
      payload: JSON.stringify({ ...record, uuid: foreign }),
    }),
  );
  await expect(save({ ...record, uuid: foreign })).rejects.toMatchObject(
    shown("Record belongs to another Flight Program."),
  );
});
