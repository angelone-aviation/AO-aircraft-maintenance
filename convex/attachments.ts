/**
 * Responsibility: Applies the domain's attachment cap to stored rows, stores
 *   an upload until its record is filed, deletes a shared upload once no
 *   record refers to it, and backfills the aircraft on older file rows.
 * Layer: Server. Action and mutation helpers, and one internal mutation run
 *   by hand; callers check access and write the audit.
 * Dependencies: convex/values, convex/server, convex/_generated (server,
 *   dataModel), ./storageReferences, ./userErrors, src/domain/attachments.
 */
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { storageReferenced } from "./storageReferences";
import { exposeRejections } from "./userErrors";
import {
  assertAttachmentRoom as assertRoomFor,
  MAX_ATTACHMENTS,
} from "../src/domain/attachments";

// The domain's cap, for callers that read a record's rows with `.take()`.
export { MAX_ATTACHMENTS };

/**
 * Refuses another attachment on a record that already holds the maximum.
 *
 * @param existing - The record's attachments, read with
 *   `.take(MAX_ATTACHMENTS)`.
 * @throws {ConvexError} "This record already has the maximum of 25
 *   attachments."
 */
export function assertAttachmentRoom(existing: unknown[]): void {
  exposeRejections(() => assertRoomFor(existing.length));
}

/**
 * Deletes an uploaded file once no record refers to it, by the schema-checked
 * list behind {@link storageReferenced}. Sample and receipt uploads share one
 * blob across records, so call this after deleting the referencing row.
 *
 * @param ctx - Mutation context; may delete the blob from file storage.
 * @param storageId - The blob the deleted row pointed at.
 */
export async function deleteBlobIfUnused(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  if (!(await storageReferenced(ctx, storageId)))
    await ctx.storage.delete(storageId);
}

/**
 * Stores an upload's bytes, then files them with `finish`. File storage is
 * outside the mutation's transaction, so a refused filing deletes the blob
 * again and rethrows the same error.
 *
 * @param ctx - Action context; writes to file storage.
 * @param file - The bytes and their MIME type, stored as the blob's type.
 * @param finish - Files the stored blob, usually a `runMutation`.
 * @returns What `finish` returns.
 * @throws Whatever `finish` throws, unchanged, after the blob is deleted.
 */
export async function storeThenFinish<T>(
  ctx: Pick<ActionCtx, "storage">,
  file: { bytes: ArrayBuffer; type: string },
  finish: (storageId: Id<"_storage">) => Promise<T>,
): Promise<T> {
  const storageId = await ctx.storage.store(
    new Blob([file.bytes], { type: file.type }),
  );
  try {
    return await finish(storageId);
  } catch (error) {
    await ctx.storage.delete(storageId);
    throw error;
  }
}

// Rows patched per transaction, well inside Convex's per-mutation limits.
const BACKFILL_BATCH = 100;
const FILE_TABLES = ["taskEvidence", "workOrderFiles"] as const;
type FileTable = (typeof FILE_TABLES)[number];
// By name: this module had no Convex function before, so the committed
// generated API does not list it until the next codegen.
const BACKFILL_AIRCRAFT = makeFunctionReference<
  "mutation",
  { table: FileTable; cursor: string | null }
>("attachments:backfillAircraft");

/**
 * Stores the aircraft on job-card evidence and work-order files uploaded
 * before rows carried it, so the snapshot reads them once per aircraft; one
 * page per transaction, scheduling the next until both tables are done.
 * Idempotent; run once after deploying with
 * `npx convex run attachments:backfillAircraft`. Writes no change-log row:
 * it fills a storage key from the record's own aircraft and changes no
 * record. A file whose record no longer exists is left as it is.
 *
 * @param table - The table to resume; evidence first by default.
 * @param cursor - The page to resume from; omitted or null starts at the
 *   first.
 * @returns The table and how many of this page's rows were filled, and
 *   whether both tables are done.
 */
export const backfillAircraft = internalMutation({
  args: {
    table: v.optional(v.union(...FILE_TABLES.map((t) => v.literal(t)))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { table = "taskEvidence", cursor }) => {
    const page = await ctx.db
      .query(table)
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", undefined))
      .paginate({ cursor: cursor ?? null, numItems: BACKFILL_BATCH });
    let filled = 0;
    for (const row of page.page) {
      const aircraftUuid = await recordAircraft(ctx, row);
      if (!aircraftUuid) continue;
      await ctx.db.patch(row._id, { aircraftUuid });
      filled++;
    }
    const next = nextPage(table, page);
    if (next) await ctx.scheduler.runAfter(0, BACKFILL_AIRCRAFT, next);
    return { table, filled, isDone: !next };
  },
});

// A job card may have been archived since its evidence was filed.
async function recordAircraft(
  ctx: MutationCtx,
  row: Doc<FileTable>,
): Promise<string | undefined> {
  if (!("taskCardUuid" in row))
    return (
      await ctx.db
        .query("workOrders")
        .withIndex("uuid", (q) => q.eq("uuid", row.workOrderUuid))
        .first()
    )?.aircraftUuid;
  for (const table of ["taskCards", "archivedTaskCards"] as const) {
    const card = await ctx.db
      .query(table)
      .withIndex("uuid", (q) => q.eq("uuid", row.taskCardUuid))
      .first();
    if (card) return card.aircraftUuid;
  }
  return undefined;
}

function nextPage(
  table: FileTable,
  page: { isDone: boolean; continueCursor: string },
) {
  if (!page.isDone) return { table, cursor: page.continueCursor };
  return table === "taskEvidence"
    ? { table: "workOrderFiles" as const, cursor: null }
    : undefined;
}
