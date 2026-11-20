/**
 * Responsibility: Pins inventory attachments: who may upload and remove them,
 *   the file checks and per-item cap, their audit rows, and when a stored
 *   file is deleted.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/inventoryFiles.ts, convex/schema.ts,
 *   src/domain/inventoryAttachments, tests/fixtures/requiredParts.
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { partsFixture } from "../tests/fixtures/requiredParts";
import { validateInventoryFile } from "../src/domain/inventoryAttachments";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const STOCK = "parts-stock";
const PDF = new TextEncoder().encode("%PDF-1.4").buffer;

// An inventory administrator and a reader of the parts fixture's program.
async function fixture() {
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    const s = partsFixture();
    for (const p of s.programs!) await ctx.db.insert("programs", p);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    for (const r of s.management!)
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        programUuid: r.programUuid,
        payload: JSON.stringify(r),
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
  return {
    t,
    admin: t.withIdentity(subjects.admin),
    reader: t.withIdentity(subjects.reader),
  };
}
it("stores inventory attachments, returns view URLs only to inventory admins, and rejects wrong scopes", async () => {
  const { t, admin, reader } = await fixture();
  const args = {
    stockUuid: "parts-stock",
    programUuid: "demo-program",
    name: "certificate.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF").buffer,
  };
  await expect(reader.action(api.inventoryFiles.upload, args)).rejects.toThrow(
    "administrator",
  );
  await expect(
    admin.action(api.inventoryFiles.upload, { ...args, stockUuid: "missing" }),
  ).rejects.toThrow();
  await expect(
    admin.action(api.inventoryFiles.upload, { ...args, programUuid: "wrong" }),
  ).rejects.toThrow("Program changed");
  await admin.action(api.inventoryFiles.upload, args);
  const snapshot = await admin.query(api.operations.snapshot, {});
  expect(snapshot!.inventoryAttachments).toHaveLength(1);
  expect(snapshot!.inventoryAttachments![0]).toMatchObject({
    stockUuid: "parts-stock",
    name: "certificate.pdf",
    type: "application/pdf",
    size: args.bytes.byteLength,
  });
  expect(snapshot!.inventoryAttachments![0].url).toBeTruthy();
  expect(snapshot!.audit.some((a) => a.action === "inventory.attachment")).toBe(
    true,
  );
  expect(
    (await reader.query(api.operations.snapshot, {}))!.inventoryAttachments,
  ).toEqual([]);
  await t.run(async (ctx) => {
    const location = await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", "parts-location"))
      .unique();
    const stock = await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", "parts-stock"))
      .unique();
    for (const doc of [location!, stock!])
      await ctx.db.patch(doc._id, {
        programUuid: "other-program",
        payload: JSON.stringify({
          ...JSON.parse(doc.payload),
          programUuid: "other-program",
        }),
      });
  });
  await expect(
    admin.query(internal.inventoryFiles.checkUpload, {
      stockUuid: "parts-stock",
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("administrator");
  expect(
    (await admin.query(api.operations.snapshot, {}))!.inventoryAttachments,
  ).toEqual([]);
});
it("accepts supported files and rejects empty, oversized or mismatched uploads", () => {
  for (const [name, type] of [
    ["photo.JPG", "image/jpeg"],
    ["photo.png", "image/png"],
    ["photo.webp", "image/webp"],
    ["invoice.pdf", "application/pdf"],
  ])
    expect(() => validateInventoryFile(name, type, 10)).not.toThrow();
  expect(() => validateInventoryFile("test.html", "text/html", 10)).toThrow(
    "Choose",
  );
  expect(() =>
    validateInventoryFile("test.png", "application/pdf", 10),
  ).toThrow("Choose");
  expect(() => validateInventoryFile("test.pdf", "application/pdf", 0)).toThrow(
    "7 MiB",
  );
  expect(() =>
    validateInventoryFile("test.pdf", "application/pdf", 7 * 1024 * 1024 + 1),
  ).toThrow("7 MiB");
});
it("caps attachments per item and removes them with their unshared blob", async () => {
  const { t, admin } = await fixture();
  const ids = await t.run(async (ctx) => {
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const storageId = await ctx.storage.store(new Blob([`file ${i}`]));
      rows.push({
        storageId,
        id: await ctx.db.insert("inventoryFiles", {
          stockUuid: "parts-stock",
          storageId,
          name: `file-${i}.pdf`,
          type: "application/pdf",
          size: 6,
          uploadedAt: i,
        }),
      });
    }
    return rows;
  });
  await expect(
    admin.action(api.inventoryFiles.upload, {
      stockUuid: "parts-stock",
      programUuid: "demo-program",
      name: "extra.pdf",
      type: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4").buffer,
    }),
  ).rejects.toThrow(/maximum of 25/);
  await admin.mutation(api.inventoryFiles.remove, {
    id: ids[0].id,
    programUuid: "demo-program",
  });
  expect(await t.run((ctx) => ctx.db.get(ids[0].id))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.getUrl(ids[0].storageId))).toBeNull();
});
it("checks the file before access, and deletes the stored file when filing is refused", async () => {
  const { t, admin, reader } = await fixture();
  const upload = {
    stockUuid: STOCK,
    programUuid: PROGRAM,
    name: "extra.pdf",
    type: "application/pdf",
    bytes: PDF,
  };
  await expect(
    reader.action(api.inventoryFiles.upload, {
      ...upload,
      name: "page.html",
      type: "text/html",
    }),
  ).rejects.toThrow("Choose a PDF, JPEG, PNG or WebP file.");
  await expect(
    reader.action(api.inventoryFiles.upload, {
      ...upload,
      bytes: new TextEncoder().encode("<html></html>").buffer,
    }),
  ).rejects.toThrow("This file's contents do not match its type.");
  await expect(
    admin.action(api.inventoryFiles.upload, { ...upload, stockUuid: "gone" }),
  ).rejects.toThrow("Inventory administrator access to this item is required.");
  const blobs = () => t.run((ctx) => ctx.db.system.query("_storage").collect());
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["kept"]));
    for (let i = 0; i < 25; i++)
      await ctx.db.insert("inventoryFiles", {
        stockUuid: STOCK,
        storageId,
        name: `file-${i}.pdf`,
        type: "application/pdf",
        size: 4,
        uploadedAt: i,
      });
  });
  expect(await blobs()).toHaveLength(1);
  await expect(admin.action(api.inventoryFiles.upload, upload)).rejects.toThrow(
    "This record already has the maximum of 25 attachments.",
  );
  expect(await blobs()).toHaveLength(1);
});

it("keeps a file a PO receipt still uses, and audits each change with the file's name and size", async () => {
  const { t, admin } = await fixture();
  const { id, storageId } = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["receipt"]));
    const file = {
      storageId,
      name: "receipt.pdf",
      type: "application/pdf",
      size: 7,
      uploadedAt: 1,
    };
    await ctx.db.insert("poFiles", {
      ...file,
      poUuid: "po",
      programUuid: PROGRAM,
    });
    return {
      storageId,
      id: await ctx.db.insert("inventoryFiles", { ...file, stockUuid: STOCK }),
    };
  });
  await admin.mutation(api.inventoryFiles.remove, { id, programUuid: PROGRAM });
  expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
  await admin.action(api.inventoryFiles.upload, {
    stockUuid: STOCK,
    programUuid: PROGRAM,
    name: "invoice.pdf",
    type: "application/pdf",
    bytes: PDF,
  });
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(
    rows.map(({ action, entityUuid, programUuid, before, after }) => ({
      action,
      entityUuid,
      programUuid,
      before,
      after,
    })),
  ).toEqual([
    {
      action: "inventory.attachment_removed",
      entityUuid: STOCK,
      programUuid: PROGRAM,
      before: JSON.stringify({ name: "receipt.pdf", size: 7 }),
      after: undefined,
    },
    {
      action: "inventory.attachment",
      entityUuid: STOCK,
      programUuid: PROGRAM,
      before: undefined,
      after: JSON.stringify({ name: "invoice.pdf", size: PDF.byteLength }),
    },
  ]);
});
