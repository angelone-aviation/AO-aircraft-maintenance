/**
 * Responsibility: Pins purchase orders: atomic receipts and replays, address
 *   confirmation, attachments and who may list them, and uuids another Flight
 *   Program holds.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/purchaseOrders, convex/poFiles, src/data/demo,
 *   src/domain/purchaseOrders.
 */
import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { poDraftSchema, poSchema } from "../src/domain/purchaseOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;

it("persists PO receipts atomically and replays without double inventory or audit entries", async () => {
  const t = convexTest(schema, modules);
  const demo = demoSnapshot();
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    const user = await ctx.db.insert("users", {
      name: "PO admin",
      isAdmin: true,
      active: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + DAY_MS,
    });
    await ctx.db.insert("management", {
      uuid: "store",
      programUuid: "demo-program",
      kind: "location",
      payload: JSON.stringify({
        uuid: "store",
        version: 1,
        programUuid: "demo-program",
        kind: "location",
        name: "Store",
        address: "",
        contact: "",
      }),
    });
    return { subject: `${user}|${session}` };
  });
  const client = t.withIdentity(identity);
  const d = poDraftSchema.parse({
    uuid: "po-test",
    version: 0,
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [
      {
        uuid: "line",
        locationUuid: "store",
        partNumber: "TEST-P",
        description: "Test part",
        quantity: 3,
        unitCents: 100,
        kind: "part",
      },
    ],
  });
  const command = async (c: unknown) =>
    client.mutation(api.purchaseOrders.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  await command({
    kind: "save",
    requestUuid: crypto.randomUUID(),
    drafts: [d],
  });
  await command({
    kind: "issue",
    requestUuid: crypto.randomUUID(),
    uuid: d.uuid,
    version: 1,
    reason: "",
  });
  const receipt = {
    kind: "receive",
    requestUuid: crypto.randomUUID(),
    uuid: d.uuid,
    version: 2,
    date: new Date().toISOString().slice(0, 10),
    invoice: "INV-1",
    notes: "",
    lines: [{ lineUuid: "line", quantity: 2, condition: "new", serials: [] }],
  };
  await command(receipt);
  const counts = () =>
    t.run(async (ctx) => ({
      stock: (await ctx.db.query("management").collect())
        .filter((r) => r.kind === "stock")
        .map((r) => JSON.parse(r.payload)),
      audit: await ctx.db.query("audit").collect(),
    }));
  const before = await counts();
  await command(receipt);
  expect(await counts()).toEqual(before);
  expect(before.stock).toHaveLength(1);
  expect(before.stock[0].quantity).toBe(2);
  await expect(
    command({
      ...receipt,
      requestUuid: crypto.randomUUID(),
      version: 3,
      lines: [{ lineUuid: "line", quantity: 2, condition: "new", serials: [] }],
    }),
  ).rejects.toThrow("outstanding");
  expect(await counts()).toEqual(before);
  await expect(
    client.mutation(api.purchaseOrders.execute, {
      programUuid: "other",
      payload: JSON.stringify(receipt),
    }),
  ).rejects.toThrow("Program changed");
  await client.action(api.poFiles.upload, {
    programUuid: "demo-program",
    poUuid: d.uuid,
    receiptUuid: receipt.requestUuid,
    name: "invoice.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4 test").buffer,
  });
  const files = await client.query(api.purchaseOrders.files, {
    programUuid: "demo-program",
    poUuid: d.uuid,
  });
  expect(files).toHaveLength(1);
  expect(files[0]).toEqual({
    uuid: expect.any(String),
    name: "invoice.pdf",
    receiptUuid: receipt.requestUuid,
    url: expect.any(String),
  });
  const inventoryFiles = await t.run((ctx) =>
    ctx.db.query("inventoryFiles").collect(),
  );
  expect(inventoryFiles).toHaveLength(1);
  expect(inventoryFiles[0].stockUuid).toBe(before.stock[0].uuid);
  await expect(
    client.action(api.poFiles.upload, {
      programUuid: "other",
      poUuid: d.uuid,
      name: "invoice.pdf",
      type: "application/pdf",
      // A real PDF header, so the program check is what refuses it.
      bytes: new TextEncoder().encode("%PDF-1.4 test").buffer,
    }),
  ).rejects.toThrow("Program changed");
});

it("returns an actionable address confirmation error without issuing the PO", async () => {
  const t = convexTest(schema, modules);
  const { poSchema } = await import("../src/domain/purchaseOrders");
  const { addressSchema } = await import("../src/domain/addresses");
  const identity = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const userId = await ctx.db.insert("users", {
      name: "Admin",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + DAY_MS,
    });
    await ctx.db.insert("management", {
      uuid: "store",
      programUuid: "demo-program",
      kind: "location",
      payload: JSON.stringify({
        uuid: "store",
        version: 1,
        programUuid: "demo-program",
        kind: "location",
        name: "Store",
        address: "",
        contact: "",
      }),
    });
    const po = poSchema.parse({
      uuid: "unconfirmed-po",
      version: 1,
      programUuid: "demo-program",
      number: "PO-1",
      vendor: "Vendor",
      vendorContact: "",
      shipTo: "Hangar",
      shippingAddress: addressSchema.parse({
        street: "123 Main Street",
        city: "Atlanta",
        region: "GA",
        postalCode: "30301",
        country: "United States",
        contactName: "Receiving",
        email: "receiving@example.com",
        phone: "+1 202 555 0100",
        confirmed: false,
      }),
      expectedDate: "",
      currency: "USD",
      shippingCents: 0,
      notes: "",
      phase: "draft",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      shipments: [],
      receipts: [],
      history: [],
      lines: [
        {
          uuid: "line",
          locationUuid: "store",
          partNumber: "AN3",
          description: "Bolt",
          quantity: 1,
          unitCents: 100,
          kind: "part",
        },
      ],
    });
    await ctx.db.insert("purchaseOrders", {
      uuid: po.uuid,
      programUuid: po.programUuid,
      payload: JSON.stringify(po),
    });
    return { subject: `${userId}|${session}` };
  });
  await expect(
    t.withIdentity(identity).mutation(api.purchaseOrders.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        kind: "issue",
        uuid: "unconfirmed-po",
        version: 1,
        requestUuid: "issue-attempt",
        reason: "",
      }),
    }),
  ).rejects.toMatchObject({
    data: "Review and confirm the shipping address before issuing this PO.",
  });
  const stored = await t.run((ctx) => ctx.db.query("purchaseOrders").unique());
  expect(JSON.parse(stored!.payload).phase).toBe("draft");
});
it("deletes PO attachments only for program administrators while the PO is a draft", async () => {
  const t = convexTest(schema, modules);
  const demo = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    const session = async (
      user: Awaited<ReturnType<typeof ctx.db.insert<"users">>>,
    ) =>
      `${user}|${await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + DAY_MS,
      })}`;
    const readers = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Readers",
      aircraftIds: [],
      permissions: ["read"],
    });
    const admin = await ctx.db.insert("users", {
      name: "Admin",
      isAdmin: true,
      active: true,
      groupIds: [],
      activeProgramUuid: "demo-program",
    });
    const reader = await ctx.db.insert("users", {
      name: "Reader",
      isAdmin: false,
      active: true,
      groupIds: [readers],
    });
    const po = (phase: string, uuid: string) =>
      ctx.db.insert("purchaseOrders", {
        uuid,
        programUuid: "demo-program",
        payload: JSON.stringify(
          poSchema.parse({
            ...poDraftSchema.parse({
              uuid,
              version: 1,
              vendor: "Vendor",
              vendorContact: "",
              shipTo: "Hangar",
              expectedDate: "",
              currency: "USD",
              shippingCents: 0,
              notes: "",
              lines: [
                {
                  uuid: "line",
                  locationUuid: "store",
                  partNumber: "P",
                  description: "Part",
                  quantity: 1,
                  unitCents: 100,
                  kind: "part",
                },
              ],
            }),
            programUuid: "demo-program",
            number: uuid,
            phase,
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
            shipments: [],
            receipts: [],
            history: [],
          }),
        ),
      });
    await po("draft", "po-draft");
    await po("issued", "po-issued");
    const file = async (poUuid: string) =>
      ctx.db.insert("poFiles", {
        poUuid,
        programUuid: "demo-program",
        storageId: await ctx.storage.store(new Blob([poUuid])),
        name: `${poUuid}.pdf`,
        type: "application/pdf",
        size: 3,
        uploadedAt: 1,
      });
    return {
      admin: await session(admin),
      reader: await session(reader),
      draft: await file("po-draft"),
      issued: await file("po-issued"),
    };
  });
  const admin = t.withIdentity({ subject: ids.admin });
  const reader = t.withIdentity({ subject: ids.reader });
  const args = { id: ids.draft, programUuid: "demo-program" };
  await expect(reader.mutation(api.poFiles.remove, args)).rejects.toThrow(
    "administrator",
  );
  await expect(
    admin.mutation(api.poFiles.remove, { ...args, programUuid: "other" }),
  ).rejects.toThrow();
  await expect(
    admin.mutation(api.poFiles.remove, {
      id: ids.issued,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("draft");
  await admin.mutation(api.poFiles.remove, args);
  const left = await t.run(async (ctx) => ({
    files: (await ctx.db.query("poFiles").collect()).map((f) => f.poUuid),
    audit: (await ctx.db.query("audit").collect()).map((a) => a.action),
  }));
  expect(left.files).toEqual(["po-issued"]);
  expect(left.audit).toEqual(["purchaseOrder.attachment_removed"]);
});

afterEach(() => vi.restoreAllMocks());

// A system administrator, a reader, a stock location, and a PO and a stock
// item that another Flight Program holds under the given uuids.
async function foreignFixture(foreign: { po: string; stock: string }) {
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const location = {
      uuid: "store",
      version: 1,
      programUuid: "demo-program",
      kind: "location" as const,
      name: "Store",
      address: "",
      contact: "",
    };
    await ctx.db.insert("management", {
      uuid: location.uuid,
      programUuid: location.programUuid,
      kind: location.kind,
      payload: JSON.stringify(location),
    });
    await ctx.db.insert("purchaseOrders", {
      uuid: foreign.po,
      programUuid: "other",
      payload: "{}",
    });
    await ctx.db.insert("management", {
      uuid: foreign.stock,
      programUuid: "other",
      kind: "stock",
      payload: "{}",
    });
    const admin = await ctx.db.insert("users", {
      name: "PO admin",
      isAdmin: true,
      active: true,
      groupIds: [],
    });
    const readers = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Readers",
      aircraftIds: [],
      permissions: ["read"],
    });
    const reader = await ctx.db.insert("users", {
      name: "Reader",
      isAdmin: false,
      active: true,
      groupIds: [readers],
      activeProgramUuid: "demo-program",
    });
    const subject = async (userId: typeof admin) =>
      `${userId}|${await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + DAY_MS,
      })}`;
    return { admin: await subject(admin), reader: await subject(reader) };
  });
  const client = t.withIdentity({ subject: subjects.admin });
  const command = (c: unknown) =>
    client.mutation(api.purchaseOrders.execute, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  const stored = () =>
    t.run(async (ctx) => ({
      purchaseOrders: await ctx.db.query("purchaseOrders").collect(),
      management: await ctx.db.query("management").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  const files = (as: keyof typeof subjects, poUuid: string) =>
    t.withIdentity({ subject: subjects[as] }).query(api.purchaseOrders.files, {
      programUuid: "demo-program",
      poUuid,
    });
  return { command, stored, files };
}

const draft = (uuid: string) =>
  poDraftSchema.parse({
    uuid,
    version: 0,
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [
      {
        uuid: "line",
        locationUuid: "store",
        partNumber: "TEST-P",
        description: "Test part",
        quantity: 1,
        unitCents: 100,
        kind: "part",
      },
    ],
  });

it("refuses a PO uuid another Flight Program holds, and writes nothing", async () => {
  const { command, stored } = await foreignFixture({
    po: "taken",
    stock: "stock-elsewhere",
  });
  const before = await stored();
  await expect(
    command({
      kind: "save",
      requestUuid: crypto.randomUUID(),
      drafts: [draft("taken")],
    }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Record belongs to another Flight Program.",
  });
  expect(await stored()).toEqual(before);
});

it("lists a PO's files only for an inventory administrator, and only within the Flight Program", async () => {
  const { files } = await foreignFixture({
    po: "po-elsewhere",
    stock: "stock-elsewhere",
  });
  await expect(files("reader", "po-elsewhere")).rejects.toMatchObject({
    name: "ConvexError",
    data: "Inventory administrator access required.",
  });
  await expect(files("admin", "po-elsewhere")).rejects.toMatchObject({
    name: "ConvexError",
    data: "PO not found.",
  });
});

it("refuses received stock under a uuid another Flight Program holds, and writes nothing", async () => {
  const taken = "11111111-1111-4111-8111-111111111111";
  const { command, stored } = await foreignFixture({
    po: "po-elsewhere",
    stock: taken,
  });
  const d = draft("po-1");
  await command({
    kind: "save",
    requestUuid: crypto.randomUUID(),
    drafts: [d],
  });
  await command({
    kind: "issue",
    requestUuid: crypto.randomUUID(),
    uuid: d.uuid,
    version: 1,
    reason: "",
  });
  const before = await stored();
  const receipt = {
    kind: "receive",
    requestUuid: crypto.randomUUID(),
    uuid: d.uuid,
    version: 2,
    date: new Date().toISOString().slice(0, 10),
    invoice: "INV-1",
    notes: "",
    lines: [{ lineUuid: "line", quantity: 1, condition: "new", serials: [] }],
  };
  vi.spyOn(crypto, "randomUUID").mockReturnValue(taken);
  await expect(command(receipt)).rejects.toMatchObject({
    name: "ConvexError",
    data: "Record belongs to another Flight Program.",
  });
  expect(await stored()).toEqual(before);
});
