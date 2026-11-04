/**
 * Responsibility: Pins saved addresses: who may list and save them, program
 *   boundaries, the checks and cap on saving, and what readers see.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/savedAddresses.ts, convex/schema.ts,
 *   src/domain/addresses, src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { blankAddress } from "../src/domain/addresses";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const input = {
  uuid: "address-a",
  version: 0,
  name: "Receiving hangar",
  address: {
    ...blankAddress(),
    street: "123 Main St",
    city: "Atlanta",
    region: "GA",
    postalCode: "30301",
    country: "United States",
    contactName: "Receiving team",
    email: "receiving@example.com",
    phone: "+1 202 555 0100",
  },
};
async function setup() {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    const program = demoSnapshot().programs![0];
    await ctx.db.insert("programs", program);
    await ctx.db.insert("programs", {
      ...program,
      uuid: "other-program",
      name: "Other",
    });
    async function member(programUuid: string, programAdmin = true) {
      const groupId = await ctx.db.insert("groups", {
        programUuid,
        name: "Program members",
        programAdmin,
        aircraftIds: [],
        permissions: ["read"],
      });
      const userId = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name: "Member",
        groupIds: [groupId],
        activeProgramUuid: programUuid,
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${session}` };
    }
    return {
      a: await member("demo-program"),
      b: await member("other-program"),
      reader: await member("demo-program", false),
    };
  });
  return {
    t,
    a: t.withIdentity(identities.a),
    b: t.withIdentity(identities.b),
    reader: t.withIdentity(identities.reader),
  };
}
it("lets program administrators save and select named addresses while enforcing program boundaries", async () => {
  const { t, a, b } = await setup();
  const saved = await a.mutation(api.savedAddresses.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(input),
  });
  expect(saved).toMatchObject({
    version: 1,
    name: input.name,
    address: {
      addressName: input.name,
      contactName: "Receiving team",
      confirmed: true,
    },
  });
  expect(
    (await a.query(api.savedAddresses.list, { programUuid: "demo-program" }))
      .entries,
  ).toHaveLength(1);
  expect(
    (await b.query(api.savedAddresses.list, { programUuid: "other-program" }))
      .entries,
  ).toHaveLength(0);
  await expect(
    b.query(api.savedAddresses.list, { programUuid: "demo-program" }),
  ).rejects.toThrow();
  await expect(
    b.mutation(api.savedAddresses.save, {
      programUuid: "other-program",
      payload: JSON.stringify({ ...input, version: 1 }),
    }),
  ).rejects.toThrow(/not found/);
  await expect(
    t.query(api.savedAddresses.list, { programUuid: "demo-program" }),
  ).rejects.toThrow();
  await b.mutation(api.savedAddresses.save, {
    programUuid: "other-program",
    payload: JSON.stringify({ ...input, uuid: "address-b" }),
  });
  expect(
    (await b.query(api.savedAddresses.list, { programUuid: "other-program" }))
      .entries,
  ).toHaveLength(1);
});
it("requires recipient details, rejects duplicate names and stale edits, and leaves document snapshots unchanged", async () => {
  const { t, a } = await setup();
  await expect(
    a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...input,
        address: { ...input.address, contactName: "" },
      }),
    }),
  ).rejects.toThrow(/recipient/);
  const saved = await a.mutation(api.savedAddresses.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(input),
  });
  await t.run((ctx) =>
    ctx.db.insert("purchaseOrders", {
      uuid: "po-snapshot",
      programUuid: "demo-program",
      payload: JSON.stringify({ shippingAddress: saved.address }),
    }),
  );
  await expect(
    a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...input,
        uuid: "duplicate",
        name: "RECEIVING HANGAR",
      }),
    }),
  ).rejects.toThrow(/already exists/);
  await expect(
    a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(input),
    }),
  ).rejects.toThrow(/changed/);
  await a.mutation(api.savedAddresses.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...input,
      version: 1,
      address: { ...input.address, street: "456 Changed St" },
    }),
  });
  const po = await t.run((ctx) => ctx.db.query("purchaseOrders").unique());
  expect(JSON.parse(po!.payload).shippingAddress.street).toBe("123 Main St");
});
it("lets readers pick saved addresses but only administrators save them or see location contacts", async () => {
  const { t, a, reader } = await setup();
  await a.mutation(api.savedAddresses.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(input),
  });
  await t.run((ctx) =>
    ctx.db.insert("management", {
      uuid: "hangar",
      programUuid: "demo-program",
      kind: "location",
      payload: JSON.stringify({
        uuid: "hangar",
        version: 1,
        programUuid: "demo-program",
        kind: "location",
        name: "Hangar",
        address: "123 Main St",
        contact: "Receiving team",
        addressDetails: input.address,
      }),
    }),
  );
  await expect(
    reader.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...input, uuid: "reader-address" }),
    }),
  ).rejects.toThrow(/administrator/);
  const seen = await reader.query(api.savedAddresses.list, {
    programUuid: "demo-program",
  });
  expect(seen.entries).toHaveLength(1);
  expect(seen.locations[0].address).toMatchObject({
    street: "123 Main St",
    contactName: "",
    email: "",
    phone: "",
  });
  const full = await a.query(api.savedAddresses.list, {
    programUuid: "demo-program",
  });
  expect(full.locations[0].address).toMatchObject({
    email: "receiving@example.com",
  });
});
it("caps saved addresses per Flight Program", async () => {
  const { t, a } = await setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 200; i++)
      await ctx.db.insert("savedAddresses", {
        ...input,
        uuid: `seed-${i}`,
        name: `Seed ${i}`,
        nameKey: `seed ${i}`,
        programUuid: "demo-program",
      });
  });
  await expect(
    a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...input, uuid: "one-too-many" }),
    }),
  ).rejects.toThrow(/up to 200/);
});
it("lists entries by name, and shows location contacts and legacy text only to administrators", async () => {
  const { t, a, reader } = await setup();
  for (const [uuid, name] of [
    ["c", "zulu dock"],
    ["a", "Alpha hangar"],
    ["b", "bravo gate"],
  ])
    await a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...input, uuid, name }),
    });
  await t.run((ctx) =>
    ctx.db.insert("management", {
      uuid: "hangar",
      programUuid: "demo-program",
      kind: "location",
      payload: JSON.stringify({
        uuid: "hangar",
        version: 1,
        programUuid: "demo-program",
        kind: "location",
        name: "Hangar",
        address: "Legacy hangar address",
        contact: "Receiving team",
        addressDetails: input.address,
      }),
    }),
  );
  const args = { programUuid: "demo-program" };
  const seen = await reader.query(api.savedAddresses.list, args);
  expect(seen.entries.map((e) => e.name)).toEqual([
    "Alpha hangar",
    "bravo gate",
    "zulu dock",
  ]);
  expect(seen.locations[0]).toMatchObject({ uuid: "hangar", legacy: "" });
  const full = await a.query(api.savedAddresses.list, args);
  expect(full.locations[0]).toMatchObject({
    legacy: "Legacy hangar address",
    address: { contactName: "Receiving team", phone: "+1 202 555 0100" },
  });
});
it("audits each save, and still saves an edit when the program is at the cap", async () => {
  const { t, a } = await setup();
  const save = (entry: object) =>
    a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...input, ...entry }),
    });
  await save({});
  await t.run(async (ctx) => {
    for (let i = 1; i < 200; i++)
      await ctx.db.insert("savedAddresses", {
        ...input,
        uuid: `seed-${i}`,
        name: `Seed ${i}`,
        nameKey: `seed ${i}`,
        programUuid: "demo-program",
      });
  });
  expect(await save({ version: 1, name: "Main hangar" })).toMatchObject({
    version: 2,
    name: "Main hangar",
  });
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(rows.map((r) => [r.action, r.entityUuid, r.programUuid])).toEqual([
    ["address.saved", input.uuid, "demo-program"],
    ["address.saved", input.uuid, "demo-program"],
  ]);
});
