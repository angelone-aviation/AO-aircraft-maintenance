/**
 * Responsibility: Pins when a stored file is kept or deleted: after its
 *   record is deleted, and when an upload's filing is refused; and the
 *   backfill of the aircraft on older file rows.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/attachments.ts, convex/storageReferences.ts,
 *   convex/schema.ts, convex/server.
 */
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import { deleteBlobIfUnused, storeThenFinish } from "./attachments";
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

it("stores the bytes with their type and keeps them once filed", async () => {
  const t = convexTest(schema, modules);
  const bytes = new TextEncoder().encode("%PDF-1.4").buffer;
  const blob = await t.run((ctx) =>
    storeThenFinish(ctx, { bytes, type: "application/pdf" }, async (id) => id),
  );
  expect(await t.run((ctx) => ctx.db.system.get(blob))).toMatchObject({
    size: bytes.byteLength,
    contentType: "application/pdf",
  });
});

it("deletes the stored bytes and rethrows the same error when filing is refused", async () => {
  const t = convexTest(schema, modules);
  const refusal = new ConvexError("Refused.");
  const outcome = await t.run(async (ctx) => {
    let stored: Id<"_storage"> | undefined;
    // Caught inside the run, so the run commits and only the helper's own
    // delete can remove the blob.
    const error = await storeThenFinish(
      ctx,
      { bytes: new ArrayBuffer(1), type: "" },
      (id) => {
        stored = id;
        return Promise.reject(refusal);
      },
    ).catch((e: unknown) => e);
    return { same: error === refusal, stored };
  });
  expect(outcome.same).toBe(true);
  expect(outcome.stored).toBeDefined();
  expect(
    await t.run((ctx) => ctx.db.system.query("_storage").collect()),
  ).toEqual([]);
});

it("backfills the aircraft on older file rows, page by page, and stops once done", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const backfill = makeFunctionReference<
      "mutation",
      Record<string, never>,
      { table: string; filled: number; isDone: boolean }
    >("attachments:backfillAircraft");
    const evidence = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["%PDF"]));
      const row = (taskCardUuid: string) =>
        ctx.db.insert("taskEvidence", {
          name: FILE.name,
          size: FILE.size,
          taskCardUuid,
          storageId,
          uploadedAt: 1,
          category: "photo",
        });
      await ctx.db.insert("taskCards", {
        uuid: "card",
        aircraftUuid: "A",
        payload: "{}",
      });
      await ctx.db.insert("archivedTaskCards", {
        uuid: "old",
        aircraftUuid: "B",
        payload: "{}",
      });
      await ctx.db.insert("workOrders", {
        uuid: "order",
        aircraftUuid: "A",
        payload: "{}",
      });
      await ctx.db.insert("workOrderFiles", {
        name: FILE.name,
        size: FILE.size,
        workOrderUuid: "order",
        storageId,
        uploadedAt: 1,
      });
      // More than one page, so the backfill has to schedule itself.
      for (let n = 0; n < 150; n++) await row("card");
      return { archived: await row("old"), orphan: await row("deleted") };
    });
    expect(await t.mutation(backfill, {})).toEqual({
      table: "taskEvidence",
      filled: 100,
      isDone: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const aircraftOf = () =>
      t.run(async (ctx) => ({
        evidence: (await ctx.db.query("taskEvidence").collect()).map(
          (r) => [r._id, r.aircraftUuid ?? null] as const,
        ),
        orders: (await ctx.db.query("workOrderFiles").collect()).map(
          (r) => r.aircraftUuid ?? null,
        ),
      }));
    const once = await aircraftOf();
    const byId = new Map(once.evidence);
    expect(byId.get(evidence.archived)).toBe("B");
    expect(byId.get(evidence.orphan)).toBeNull();
    expect(once.evidence.filter(([, a]) => a === "A")).toHaveLength(150);
    expect(once.orders).toEqual(["A"]);
    await t.mutation(backfill, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await aircraftOf()).toEqual(once);
  } finally {
    vi.useRealTimers();
  }
});
