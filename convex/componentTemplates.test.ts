/**
 * Responsibility: Pins component templates on the server: program-scoped
 *   saving and its stored rows, setup entries added once without installing
 *   components, refusals shown with their message, and replayed request ids.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/componentTemplates, convex/schema, src/data/demo
 *   (fixture).
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { STALE_RECORD_MESSAGE } from "../src/domain/rejection";
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
    const [template] = await ctx.db.query("componentTemplates").collect();
    expect(template).toMatchObject({
      uuid: record.uuid,
      programUuid: "demo-program",
    });
    expect(JSON.parse(template.payload)).toMatchObject({
      uuid: record.uuid,
      programUuid: "demo-program",
      version: 1,
    });
    const setups = await ctx.db.query("componentSetups").collect();
    expect(setups).toHaveLength(1);
    expect(setups[0]).toMatchObject({
      uuid: JSON.parse(setups[0].payload).uuid,
      programUuid: "demo-program",
      aircraftUuid: a.uuid,
    });
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
  await expect(save(record)).rejects.toMatchObject(shown(STALE_RECORD_MESSAGE));
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
  ).rejects.toMatchObject(shown(STALE_RECORD_MESSAGE));
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

it("writes the save with the program, then a setupImported row per setup in row order", async () => {
  const { t, a, client, record, save } = await setup();
  const child = {
    ...record.rows[0],
    id: "2",
    parentId: "1",
    componentType: "Propeller",
    partNumber: "P2",
    model: "Propeller",
  };
  await save({ ...record, rows: [...record.rows, child] });
  await client.mutation(api.componentTemplates.apply, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      templateUuid: record.uuid,
      version: 1,
      aircraftUuid: a.uuid,
      rowIds: ["1", "2"],
    }),
  });
  const { audit, setups } = await t.run(async (ctx) => ({
    audit: await ctx.db.query("audit").collect(),
    setups: await ctx.db.query("componentSetups").collect(),
  }));
  expect(audit.map((r) => [r.action, r.programUuid, r.aircraftUuid])).toEqual([
    ["componentTemplate.save", "demo-program", undefined],
    ["component.setupImported", "demo-program", a.uuid],
    ["component.setupImported", "demo-program", a.uuid],
  ]);
  expect(audit.slice(1).map((r) => JSON.parse(r.after!))).toEqual(
    setups.map((d) => JSON.parse(d.payload)),
  );
  expect(audit.slice(1).map((r) => JSON.parse(r.after!).row.id)).toEqual([
    "1",
    "2",
  ]);
  expect(audit.slice(1).every((r) => r.before === undefined)).toBe(true);
});

it("saves and applies once per request id: a replay returns nothing and writes nothing", async () => {
  const { t, a, client, record } = await setup();
  const requestUuid = crypto.randomUUID();
  const save = (name: string) =>
    client.mutation(api.componentTemplates.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...record, name, requestUuid }),
    });
  const apply = {
    programUuid: "demo-program",
    payload: JSON.stringify({
      templateUuid: record.uuid,
      version: 1,
      aircraftUuid: a.uuid,
      rowIds: ["1"],
      requestUuid: crypto.randomUUID(),
    }),
  };
  const stored = () =>
    t.run(async (ctx) => ({
      templates: await ctx.db.query("componentTemplates").collect(),
      setups: await ctx.db.query("componentSetups").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
    }));
  expect(await save(record.name)).toBe(record.uuid);
  const saved = await stored();
  // The domain schema drops the request id, so the template never holds it.
  expect(JSON.parse(saved.templates[0].payload)).not.toHaveProperty(
    "requestUuid",
  );
  await expect(save(record.name)).resolves.toBeNull();
  expect(await stored()).toEqual(saved);
  await expect(save("Renamed")).rejects.toMatchObject({
    data: "Request identifier already used.",
  });
  expect(await client.mutation(api.componentTemplates.apply, apply)).toBe(1);
  const applied = await stored();
  await expect(
    client.mutation(api.componentTemplates.apply, apply),
  ).resolves.toBeNull();
  expect(await stored()).toEqual(applied);
  expect(applied.commandRequests.map((r) => r.payload)).toEqual([
    JSON.stringify({ ...record, name: record.name, requestUuid }),
    apply.payload,
  ]);
});
