/**
 * Responsibility: Pins when a deleted record's stored file is kept or deleted.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/attachments.ts, convex/storageReferences.ts,
 *   convex/schema.ts.
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { deleteBlobIfUnused } from "./attachments";
import { STORAGE_REFERENCES } from "./storageReferences";
import type { MutationCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const FILE = { name: "file.pdf", type: "application/pdf", size: 4 };

// One minimal row per table in STORAGE_REFERENCES that points at `storageId`.
const REFERENCES: Partial<
  Record<
    TableNames,
    (ctx: MutationCtx, storageId: Id<"_storage">) => Promise<string>
  >
> = {
  aircraftFiles: (ctx, storageId) =>
    ctx.db.insert("aircraftFiles", {
      ...FILE,
      aircraftUuid: "aircraft",
      category: "form-337",
      storageId,
      uploadedAt: 1,
    }),
  aircraftPhotos: (ctx, storageId) =>
    ctx.db.insert("aircraftPhotos", { aircraftUuid: "aircraft", storageId }),
  certificationFiles: async (ctx, storageId) =>
    ctx.db.insert("certificationFiles", {
      ...FILE,
      userId: await ctx.db.insert("users", {}),
      kind: "medical",
      storageId,
      uploadedAt: 1,
    }),
  inventoryFiles: (ctx, storageId) =>
    ctx.db.insert("inventoryFiles", {
      ...FILE,
      stockUuid: "stock",
      storageId,
      uploadedAt: 1,
    }),
  manualUploads: (ctx, storageId) =>
    ctx.db.insert("manualUploads", {
      payload: "{}",
      userId: "user",
      createdAt: 1,
      storageId,
    }),
  manuals: (ctx, storageId) =>
    ctx.db.insert("manuals", {
      uuid: "manual",
      aircraftUuid: "aircraft",
      title: "Manual",
      documentNumber: "D-1",
      revision: "1",
      revisionDate: "2026-01-01",
      filename: FILE.name,
      size: FILE.size,
      pageCount: 1,
      storageId,
      uploadedAt: 1,
      uploadedBy: "user",
    }),
  poFiles: (ctx, storageId) =>
    ctx.db.insert("poFiles", {
      ...FILE,
      poUuid: "po",
      programUuid: "program",
      storageId,
      uploadedAt: 1,
    }),
  spruceAccounts: (ctx, catalogId) =>
    ctx.db.insert("spruceAccounts", {
      programUuid: "program",
      version: 1,
      catalogId,
    }),
  taskEvidence: (ctx, storageId) =>
    ctx.db.insert("taskEvidence", {
      name: FILE.name,
      size: FILE.size,
      taskCardUuid: "card",
      category: "photo",
      storageId,
      uploadedAt: 1,
    }),
  workOrderFiles: (ctx, storageId) =>
    ctx.db.insert("workOrderFiles", {
      name: FILE.name,
      size: FILE.size,
      workOrderUuid: "order",
      storageId,
      uploadedAt: 1,
    }),
};

async function refer<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  storageId: Id<"_storage">,
): Promise<Id<T>> {
  const insert = REFERENCES[table];
  if (!insert) throw new Error(`No test row for ${table}.`);
  return (await insert(ctx, storageId)) as Id<T>;
}

it.each(STORAGE_REFERENCES.map((r) => [`${r.table}.${r.field}`, r.table]))(
  "keeps a blob that %s still refers to",
  async (_, table) => {
    const t = convexTest(schema, modules);
    const blob = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["file"]));
      await refer(ctx, table, storageId);
      await deleteBlobIfUnused(ctx, storageId);
      return storageId;
    });
    expect(await t.run((ctx) => ctx.db.system.get(blob))).not.toBeNull();
  },
);

it("keeps a blob a PO receipt and an inventory item share until both are deleted", async () => {
  const t = convexTest(schema, modules);
  const blob = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["receipt"]));
    const receipt = await refer(ctx, "poFiles", storageId);
    const last = await refer(ctx, "inventoryFiles", storageId);
    await ctx.db.delete(receipt);
    await deleteBlobIfUnused(ctx, storageId);
    return { storageId, last };
  });
  expect(
    await t.run((ctx) => ctx.db.system.get(blob.storageId)),
  ).not.toBeNull();
  await t.run(async (ctx) => {
    await ctx.db.delete(blob.last);
    await deleteBlobIfUnused(ctx, blob.storageId);
  });
  expect(await t.run((ctx) => ctx.db.system.get(blob.storageId))).toBeNull();
});

it("deletes a blob no record refers to", async () => {
  const t = convexTest(schema, modules);
  const blob = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["orphan"]));
    await deleteBlobIfUnused(ctx, storageId);
    return storageId;
  });
  expect(await t.run((ctx) => ctx.db.system.get(blob))).toBeNull();
});
