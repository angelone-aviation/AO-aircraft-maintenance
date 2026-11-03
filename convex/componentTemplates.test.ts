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
it("persists program-scoped templates and idempotent setup entries without creating installed components", async () => {
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
  const uuid = crypto.randomUUID();
  const record = {
    uuid,
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
  await client.mutation(api.componentTemplates.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(record),
  });
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify({
      templateUuid: uuid,
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
