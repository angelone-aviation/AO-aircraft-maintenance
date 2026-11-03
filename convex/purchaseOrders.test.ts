import { convexTest } from "convex-test";
import { it, expect } from "vitest";
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
      expirationTime: Date.now() + 86400000,
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
      bytes: new TextEncoder().encode("test").buffer,
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
      expirationTime: Date.now() + 86400000,
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
        expirationTime: Date.now() + 86400000,
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
