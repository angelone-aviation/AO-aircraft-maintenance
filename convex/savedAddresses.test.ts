/**
 * Responsibility: Pins saved addresses: who may list and save them, program
 *   boundaries, the checks and cap on saving, what readers see, and what
 *   the change log keeps of an edit and for whom.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/savedAddresses.ts, convex/auditHistory.ts,
 *   convex/operations.ts, convex/schema.ts, src/domain/addresses,
 *   src/data/demo.ts (fixture).
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

it("records an edit's before and after, and lets only program administrators read the address's history", async () => {
  const { t, a, b, reader } = await setup();
  const save = (entry: object) =>
    a.mutation(api.savedAddresses.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...input, ...entry }),
    });
  await save({});
  const moved = { ...input.address, street: "99 Other Rd" };
  await save({ version: 1, address: moved });
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(rows[0].before).toBeUndefined();
  expect(JSON.parse(rows[0].after!)).toMatchObject({
    version: 1,
    address: { street: "123 Main St" },
  });
  expect(JSON.parse(rows[1].before!)).toEqual(JSON.parse(rows[0].after!));
  expect(JSON.parse(rows[1].after!)).toMatchObject({
    uuid: input.uuid,
    version: 2,
    programUuid: "demo-program",
    address: { street: "99 Other Rd" },
  });
  // The lookup key is storage detail, not part of the record.
  expect(rows[1].after).not.toContain("nameKey");
  const history = (programUuid: string, entityUuid?: string) => ({
    programUuid,
    entityUuid,
    cursor: null,
    numItems: 10,
  });
  const own = await a.query(
    api.auditHistory.page,
    history("demo-program", input.uuid),
  );
  expect(own.page.map((e) => e.action)).toEqual([
    "address.saved",
    "address.saved",
  ]);
  const program = await a.query(api.auditHistory.page, history("demo-program"));
  expect(program.page).toHaveLength(2);
  const snapshot = await a.query(api.operations.snapshot, {});
  expect(snapshot?.audit).toHaveLength(2);
  // Readers pick addresses but do not read who changed the directory.
  expect(
    (await reader.query(api.auditHistory.page, history("demo-program"))).page,
  ).toEqual([]);
  expect((await reader.query(api.operations.snapshot, {}))?.audit).toEqual([]);
  await expect(
    reader.query(api.auditHistory.page, history("demo-program", input.uuid)),
  ).rejects.toThrow("History not found.");
  await expect(
    b.query(api.auditHistory.page, history("other-program", input.uuid)),
  ).rejects.toThrow("History not found.");
});

it("refuses as ConvexError in order: administrator, entry, owner, version, name, cap", async () => {
  const { t, a, b, reader } = await setup();
  const save = (who: typeof a, programUuid: string, payload: string) =>
    who.mutation(api.savedAddresses.save, { programUuid, payload });
  const refused = (data: string) => ({ name: "ConvexError", data });
  const entry = (fields: object) => JSON.stringify({ ...input, ...fields });
  await expect(save(reader, "demo-program", "{")).rejects.toMatchObject(
    refused("Flight Program administrator required."),
  );
  const incomplete = refused(
    "Enter an address name and complete the recipient name, address, email and phone fields.",
  );
  for (const payload of ["{", entry({ name: " " }), entry({ version: -1 })])
    await expect(save(a, "demo-program", payload)).rejects.toMatchObject(
      incomplete,
    );
  await save(b, "other-program", entry({ uuid: "foreign" }));
  await expect(
    save(a, "demo-program", entry({ uuid: "foreign", version: 5 })),
  ).rejects.toMatchObject(refused("Address not found in this Flight Program."));
  await save(a, "demo-program", entry({}));
  await expect(
    save(a, "demo-program", entry({ uuid: "other", version: 1 })),
  ).rejects.toMatchObject(refused("Address changed. Reopen it before saving."));
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
  await expect(
    save(a, "demo-program", entry({ uuid: "new", name: " SEED 7 " })),
  ).rejects.toMatchObject(
    refused(
      "An address with this name already exists in this program. Select it or use another name.",
    ),
  );
  await expect(
    save(a, "demo-program", entry({ uuid: "new", name: "Fresh" })),
  ).rejects.toMatchObject(
    refused(
      "A Flight Program can keep up to 200 saved addresses. Edit an existing address instead.",
    ),
  );
  const stored = await t.run((ctx) =>
    ctx.db
      .query("savedAddresses")
      .withIndex("uuid", (q) => q.eq("uuid", input.uuid))
      .unique(),
  );
  expect(stored).toMatchObject({
    version: 1,
    name: input.name,
    nameKey: input.name.toLowerCase(),
    programUuid: "demo-program",
    address: { ...input.address, addressName: input.name, confirmed: true },
  });
});
