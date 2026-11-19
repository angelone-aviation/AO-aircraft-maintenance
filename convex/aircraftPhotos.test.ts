/**
 * Responsibility: Pins aircraft photos: maintenance permission within the
 *   active program, replacing and removing the stored image, the audit
 *   entries, and that no stored file outlives a failed save.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/aircraftPhotos, convex/operations (snapshot),
 *   src/data/demo.
 */
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
async function fixture() {
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
  return { t, ids, client };
}
const args = {
  aircraftUuid: demoSnapshot().aircraft[0].uuid,
  programUuid: "demo-program",
  type: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    .buffer,
};
it("scopes aircraft photos and replaces/removes storage without changing aircraft records", async () => {
  const { t, ids, client } = await fixture();
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

it("audits each change and deletes a removed photo's image", async () => {
  const { t, client } = await fixture();
  const target = {
    aircraftUuid: args.aircraftUuid,
    programUuid: args.programUuid,
  };
  // Characterizes current behaviour: remove audits without a photo.
  await client.mutation(api.aircraftPhotos.remove, target);
  await client.action(api.aircraftPhotos.upload, args);
  await client.mutation(api.aircraftPhotos.remove, target);
  const entry = (action: string) => ({
    action,
    entityUuid: args.aircraftUuid,
    ...target,
  });
  expect(await t.run((ctx) => ctx.db.query("audit").collect())).toMatchObject([
    entry("aircraft.photo_removed"),
    entry("aircraft.photo_updated"),
    entry("aircraft.photo_removed"),
  ]);
  expect(
    await t.run((ctx) => ctx.db.system.query("_storage").collect()),
  ).toHaveLength(0);
});

it("keeps no stored file when saving fails, and validates before permission", async () => {
  const { t, ids, client } = await fixture();
  const blobs = () =>
    t.run(
      async (ctx) => (await ctx.db.system.query("_storage").collect()).length,
    );
  // Two rows for one aircraft make finish's unique() read throw.
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["old"]));
    for (let i = 0; i < 2; i++)
      await ctx.db.insert("aircraftPhotos", {
        aircraftUuid: args.aircraftUuid,
        storageId,
      });
  });
  await expect(
    client.action(api.aircraftPhotos.upload, args),
  ).rejects.toThrow();
  expect(await blobs()).toBe(1);
  await t.run((ctx) => ctx.db.patch(ids.group, { programAdmin: false }));
  await expect(
    client.action(api.aircraftPhotos.upload, { ...args, type: "text/html" }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Choose a JPEG, PNG or WebP aircraft photo.",
  });
  await expect(
    client.mutation(api.aircraftPhotos.remove, {
      aircraftUuid: args.aircraftUuid,
      programUuid: args.programUuid,
    }),
  ).rejects.toThrow("Aircraft maintenance permission required.");
});

it("refuses a photo whose first bytes are not its declared type, before permission and storing nothing", async () => {
  const { t, ids, client } = await fixture();
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const heic = new Uint8Array([
    0,
    0,
    0,
    24,
    ...new TextEncoder().encode("ftypheic"),
  ]);
  await t.run((ctx) => ctx.db.patch(ids.group, { programAdmin: false }));
  for (const bytes of [svg, heic])
    await expect(
      client.action(api.aircraftPhotos.upload, {
        ...args,
        bytes: bytes.buffer,
      }),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: "This file's contents do not match its type. Choose a PDF, JPEG, PNG or WebP file.",
    });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("aircraftPhotos").collect()).toEqual([]);
    expect(await ctx.db.system.query("_storage").collect()).toEqual([]);
  });
});
