import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
it("scopes aircraft photos and replaces/removes storage without changing aircraft records", async () => {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    const aircraft = await ctx.db.insert("aircraft", demo.aircraft[0]);
    await ctx.db.insert("aircraft", {
      ...demo.aircraft[0],
      uuid: "foreign-aircraft",
      registration: "FOREIGN",
      programUuid: "foreign",
    });
    const group = await ctx.db.insert("groups", {
      name: "Program managers",
      programUuid: "demo-program",
      programAdmin: true,
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
    return { aircraft, user, session, group };
  });
  const client = t.withIdentity({ subject: `${ids.user}|${ids.session}` });
  const args = {
    aircraftUuid: demo.aircraft[0].uuid,
    programUuid: "demo-program",
    type: "image/png",
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
  };
  await expect(
    client.action(api.aircraftPhotos.upload, {
      ...args,
      aircraftUuid: "foreign-aircraft",
    }),
  ).rejects.toThrow(/permission/);
  await expect(
    client.action(api.aircraftPhotos.upload, { ...args, type: "text/html" }),
  ).rejects.toThrow(/JPEG/);
  const original = await t.run((ctx) => ctx.db.get(ids.aircraft));
  await client.action(api.aircraftPhotos.upload, args);
  const photo = await t.run((ctx) => ctx.db.query("aircraftPhotos").unique());
  const snapshot = await client.query(api.operations.snapshot, {});
  expect(
    snapshot!.aircraft.find((a) => a.uuid === args.aircraftUuid)?.photoUrl,
  ).toBeTruthy();
  expect(snapshot!.aircraft.some((a) => a.uuid === "foreign-aircraft")).toBe(
    false,
  );
  await client.action(api.aircraftPhotos.upload, args);
  expect(await t.run((ctx) => ctx.storage.get(photo!.storageId))).toBeNull();
  expect(
    await t.run((ctx) => ctx.db.query("aircraftPhotos").collect()),
  ).toHaveLength(1);
  await client.mutation(api.aircraftPhotos.remove, {
    aircraftUuid: args.aircraftUuid,
    programUuid: args.programUuid,
  });
  expect(
    await t.run((ctx) => ctx.db.query("aircraftPhotos").collect()),
  ).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get(ids.aircraft))).toEqual(original);
  await t.run((ctx) => ctx.db.patch(ids.group, { programAdmin: false }));
  await expect(client.action(api.aircraftPhotos.upload, args)).rejects.toThrow(
    /permission/,
  );
});
