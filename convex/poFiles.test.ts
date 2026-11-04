/**
 * Responsibility: Pins purchase-order attachments: who may upload and remove
 *   them, the copies a receipt's file puts on the items it received, and when
 *   a stored file is deleted.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/poFiles.ts, convex/schema.ts, src/domain/purchaseOrders,
 *   src/data/demo.ts (fixture).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { poSchema } from "../src/domain/purchaseOrders";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const PDF = new TextEncoder().encode("%PDF-1.4").buffer;

// A draft order whose one receipt brought in stock-a twice and stock-b.
function order(uuid: string, programUuid: string) {
  return poSchema.parse({
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
        quantity: 3,
        unitCents: 100,
        kind: "part",
      },
    ],
    programUuid,
    number: uuid,
    phase: "draft",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    shipments: [],
    receipts: [
      {
        uuid: "receipt",
        date: "2026-01-01",
        invoice: "",
        notes: "",
        actorId: "user",
        lines: [
          {
            lineUuid: "line",
            quantity: 3,
            condition: "new",
            itemUuids: ["stock-a", "stock-b", "stock-a"],
            serials: [],
          },
        ],
      },
    ],
    history: [],
  });
}

async function fixture() {
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    for (const [uuid, programUuid] of [
      ["po", PROGRAM],
      ["foreign-po", "other-program"],
    ])
      await ctx.db.insert("purchaseOrders", {
        uuid,
        programUuid,
        payload: JSON.stringify(order(uuid, programUuid)),
      });
    const account = async (programAdmin: boolean) => {
      const group = await ctx.db.insert("groups", {
        name: "Inventory group",
        programUuid: PROGRAM,
        programAdmin,
        permissions: ["read"],
        aircraftIds: [],
      });
      const user = await ctx.db.insert("users", {
        name: "Test user",
        active: true,
        isAdmin: false,
        activeProgramUuid: PROGRAM,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${user}|${session}` };
    };
    return { admin: await account(true), reader: await account(false) };
  });
  const upload = {
    poUuid: "po",
    programUuid: PROGRAM,
    name: "invoice.pdf",
    type: "application/pdf",
    bytes: PDF,
  };
  return {
    t,
    upload,
    admin: t.withIdentity(subjects.admin),
    reader: t.withIdentity(subjects.reader),
  };
}

it("checks the file first, then the administrator, the order's program and the receipt", async () => {
  const { admin, reader, upload } = await fixture();
  const refusals: [string, () => Promise<unknown>][] = [
    [
      "Choose a PDF, JPEG, PNG or WebP file.",
      () =>
        reader.action(api.poFiles.upload, {
          ...upload,
          name: "page.html",
          type: "text/html",
        }),
    ],
    [
      "Inventory administrator access required.",
      () => reader.action(api.poFiles.upload, upload),
    ],
    [
      "PO not found.",
      () =>
        admin.action(api.poFiles.upload, { ...upload, poUuid: "foreign-po" }),
    ],
    [
      "Receipt not found.",
      () =>
        admin.action(api.poFiles.upload, { ...upload, receiptUuid: "missing" }),
    ],
  ];
  for (const [message, run] of refusals)
    await expect(run(), message).rejects.toMatchObject({
      name: "ConvexError",
      data: message,
    });
});

it("files a receipt's file once on each item it received, sharing one blob, without a change-log row", async () => {
  const { t, admin, upload } = await fixture();
  await admin.action(api.poFiles.upload, { ...upload, receiptUuid: "receipt" });
  const stored = await t.run(async (ctx) => ({
    po: await ctx.db.query("poFiles").collect(),
    items: await ctx.db.query("inventoryFiles").collect(),
    audit: await ctx.db.query("audit").collect(),
  }));
  expect(stored.po).toMatchObject([
    { poUuid: "po", receiptUuid: "receipt", name: "invoice.pdf" },
  ]);
  expect(stored.items.map((f) => f.stockUuid)).toEqual(["stock-a", "stock-b"]);
  for (const item of stored.items)
    expect(item.storageId).toBe(stored.po[0].storageId);
  expect(stored.audit).toEqual([]);
});

it("deletes the stored file when filing is refused", async () => {
  const { t, admin, upload } = await fixture();
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["kept"]));
    for (let i = 0; i < 25; i++)
      await ctx.db.insert("poFiles", {
        poUuid: "po",
        programUuid: PROGRAM,
        storageId,
        name: `file-${i}.pdf`,
        type: "application/pdf",
        size: 4,
        uploadedAt: i,
      });
  });
  const blobs = () => t.run((ctx) => ctx.db.system.query("_storage").collect());
  expect(await blobs()).toHaveLength(1);
  await expect(admin.action(api.poFiles.upload, upload)).rejects.toThrow(
    "This record already has the maximum of 25 attachments.",
  );
  expect(await blobs()).toHaveLength(1);
});

it("removes an attachment but keeps the blob its received items still use, and audits the removal", async () => {
  const { t, admin, upload } = await fixture();
  await admin.action(api.poFiles.upload, { ...upload, receiptUuid: "receipt" });
  const file = (await t.run((ctx) => ctx.db.query("poFiles").unique()))!;
  await admin.mutation(api.poFiles.remove, {
    id: file._id,
    programUuid: PROGRAM,
  });
  expect(await t.run((ctx) => ctx.db.get(file._id))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.getUrl(file.storageId))).not.toBe(
    null,
  );
  const [row] = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(row).toMatchObject({
    action: "purchaseOrder.attachment_removed",
    entityUuid: "po",
    programUuid: PROGRAM,
    before: JSON.stringify({ name: "invoice.pdf", size: PDF.byteLength }),
  });
});
