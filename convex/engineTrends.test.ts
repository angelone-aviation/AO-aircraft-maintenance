/**
 * Responsibility: Pins engine trends on the server: read to list, maintenance
 *   to change, program scoping, the change log, the listing cap and which
 *   refusals show their message.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/engineTrends, convex/schema, src/domain/engineTrends,
 *   src/data/demo (fixture).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import {
  MAX_ENGINE_TRENDS,
  type EngineSummary,
} from "../src/domain/engineTrends";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const summary: EngineSummary = {
  source: "jpi",
  fileName: "flight-142.csv",
  date: "2026-09-14",
  start: "2026-09-14T14:00:00",
  durationSeconds: 3600,
  samples: 4,
  channels: { CHT1: { max: 440, avg: 380 }, RPM: { max: 2500, avg: 2125 } },
  maxChtSpread: 95,
};
async function setup() {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    await ctx.db.insert("aircraft", demo.aircraft[0]);
    await ctx.db.insert("aircraft", {
      ...demo.aircraft[0],
      uuid: "foreign-aircraft",
      registration: "FOREIGN",
      programUuid: "foreign",
    });
    await ctx.db.insert("engineTrends", {
      uuid: crypto.randomUUID(),
      aircraftUuid: "foreign-aircraft",
      programUuid: "foreign",
      payload: "{}",
    });
    const group = await ctx.db.insert("groups", {
      name: "Readers",
      programUuid: "demo-program",
      aircraftIds: [],
      permissions: ["read"],
    });
    const user = await ctx.db.insert("users", {
      active: true,
      isAdmin: false,
      groupIds: [group],
      activeProgramUuid: "demo-program",
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    return { user, session, group };
  });
  const client = t.withIdentity({ subject: `${ids.user}|${ids.session}` });
  const scope = {
    aircraftUuid: demo.aircraft[0].uuid,
    programUuid: "demo-program",
  };
  return { t, ids, client, scope };
}

it("requires read to view and maintenance to import, scoped to the program's aircraft", async () => {
  const { t, ids, client, scope } = await setup();
  const uuid = crypto.randomUUID();
  const importPayload = JSON.stringify({ action: "import", uuid, summary });
  expect(await client.query(api.engineTrends.list, scope)).toEqual({
    trends: [],
    limits: { chtMaxF: 435, oilPressureMinPsi: 25 },
  });
  await expect(
    client.mutation(api.engineTrends.execute, {
      ...scope,
      payload: importPayload,
    }),
  ).rejects.toThrow(/maintenance permission/);
  await t.run((ctx) =>
    ctx.db.patch(ids.group, { permissions: ["read", "maintenance"] }),
  );
  await client.mutation(api.engineTrends.execute, {
    ...scope,
    payload: importPayload,
  });
  await expect(
    client.mutation(api.engineTrends.execute, {
      ...scope,
      payload: JSON.stringify({
        action: "import",
        uuid: crypto.randomUUID(),
        summary,
      }),
    }),
  ).rejects.toThrow(/already imported/);
  await client.mutation(api.engineTrends.execute, {
    ...scope,
    payload: JSON.stringify({
      action: "limits",
      limits: { chtMaxF: 420, oilPressureMinPsi: 30 },
    }),
  });
  const data = await client.query(api.engineTrends.list, scope);
  expect(data.limits).toEqual({ chtMaxF: 420, oilPressureMinPsi: 30 });
  expect(data.trends).toEqual([
    expect.objectContaining({
      ...summary,
      uuid,
      aircraftUuid: scope.aircraftUuid,
    }),
  ]);
  const stored = await t.run((ctx) =>
    ctx.db
      .query("engineTrends")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", scope.aircraftUuid))
      .collect(),
  );
  expect(stored.map((d) => d.programUuid)).toEqual(["demo-program"]);
  // Another program's aircraft is invisible and read-only to this user.
  const foreign = { ...scope, aircraftUuid: "foreign-aircraft" };
  await expect(client.query(api.engineTrends.list, foreign)).rejects.toThrow(
    /read permission/,
  );
  await expect(
    client.mutation(api.engineTrends.execute, {
      ...foreign,
      payload: importPayload,
    }),
  ).rejects.toThrow(/maintenance permission/);
  await expect(
    client.query(api.engineTrends.list, { ...scope, programUuid: "foreign" }),
  ).rejects.toThrow(/Flight Program/);
  await client.mutation(api.engineTrends.execute, {
    ...scope,
    payload: JSON.stringify({ action: "remove", uuid }),
  });
  expect((await client.query(api.engineTrends.list, scope)).trends).toEqual([]);
  const actions = await t.run(async (ctx) =>
    (await ctx.db.query("audit").collect()).map((a) => a.action),
  );
  expect(actions).toEqual([
    "engineTrend.imported",
    "engineTrend.limits",
    "engineTrend.removed",
  ]);
});

it("lists at most MAX_ENGINE_TRENDS imports, and shows only the schema's refusal as invalid data", async () => {
  const { t, ids, client, scope } = await setup();
  await t.run((ctx) =>
    ctx.db.patch(ids.group, { permissions: ["read", "maintenance"] }),
  );
  const execute = (payload: string) =>
    client.mutation(api.engineTrends.execute, { ...scope, payload });
  const importPayload = JSON.stringify({
    action: "import",
    uuid: crypto.randomUUID(),
    summary,
  });
  await execute(importPayload);
  await expect(execute(importPayload)).rejects.toMatchObject({
    name: "ConvexError",
    data: "This engine data file was already imported.",
  });
  await expect(
    execute(JSON.stringify({ action: "bogus" })),
  ).rejects.toMatchObject({ data: "Engine trend data is invalid." });
  let syntax = "";
  try {
    JSON.parse("{");
  } catch (error) {
    syntax = (error as Error).message;
  }
  await expect(execute("{")).rejects.toMatchObject({
    name: "ConvexError",
    data: syntax,
  });
  await t.run(async (ctx) => {
    const stored = await ctx.db
      .query("engineTrends")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", scope.aircraftUuid))
      .first();
    for (let i = 0; i < MAX_ENGINE_TRENDS; i++)
      await ctx.db.insert("engineTrends", {
        uuid: crypto.randomUUID(),
        aircraftUuid: scope.aircraftUuid,
        programUuid: scope.programUuid,
        payload: stored!.payload,
      });
  });
  expect(
    (await client.query(api.engineTrends.list, scope)).trends,
  ).toHaveLength(MAX_ENGINE_TRENDS);
});

it("applies a command once per request id: a replay returns the same and writes nothing", async () => {
  const { t, ids, client, scope } = await setup();
  await t.run((ctx) =>
    ctx.db.patch(ids.group, { permissions: ["read", "maintenance"] }),
  );
  const requestUuid = crypto.randomUUID();
  const command = { action: "import", uuid: crypto.randomUUID(), summary };
  const payload = JSON.stringify({ ...command, requestUuid });
  const stored = () =>
    t.run(async (ctx) => ({
      trends: await ctx.db.query("engineTrends").collect(),
      limits: await ctx.db.query("engineTrendLimits").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
      managementRequests: await ctx.db.query("managementRequests").collect(),
    }));

  await expect(
    client.mutation(api.engineTrends.execute, { ...scope, payload }),
  ).resolves.toBeNull();
  const imported = await stored();
  expect(imported.trends).toHaveLength(2);
  expect(imported.commandRequests).toMatchObject([
    {
      uuid: requestUuid,
      payload: JSON.stringify({ aircraftUuid: scope.aircraftUuid, payload }),
    },
  ]);
  // Without the id this retry would be refused as "already imported".
  await expect(
    client.mutation(api.engineTrends.execute, { ...scope, payload }),
  ).resolves.toBeNull();
  expect(await stored()).toEqual(imported);
  for (const reuse of [
    { ...scope, aircraftUuid: "foreign-aircraft", payload },
    {
      ...scope,
      payload: JSON.stringify({
        ...command,
        summary: { ...summary, samples: 5 },
        requestUuid,
      }),
    },
  ])
    await expect(
      client.mutation(api.engineTrends.execute, reuse),
    ).rejects.toMatchObject({ data: "Request identifier already used." });
  await expect(
    client.mutation(api.engineTrends.execute, {
      ...scope,
      payload: JSON.stringify({ ...command, requestUuid: "not-a-uuid" }),
    }),
  ).rejects.toMatchObject({ data: "Engine trend data is invalid." });
  expect(await stored()).toEqual(imported);
});
