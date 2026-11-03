/**
 * Responsibility: Lists every table field that holds a file storage id, and
 *   tells whether any record still refers to a blob.
 * Layer: Server. Read-only query helper.
 * Dependencies: convex/_generated (server, dataModel).
 *
 * manuals.test.ts checks the list against the schema, so a new file table
 * cannot be missed by code that deletes blobs no record refers to.
 */
import type { QueryCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";

/**
 * Every table field that holds a file storage id. Each table has a "storage"
 * index on that field.
 */
export const STORAGE_REFERENCES: { table: TableNames; field: string }[] = [
  { table: "aircraftFiles", field: "storageId" },
  { table: "aircraftPhotos", field: "storageId" },
  { table: "certificationFiles", field: "storageId" },
  { table: "inventoryFiles", field: "storageId" },
  { table: "manualUploads", field: "storageId" },
  { table: "manuals", field: "storageId" },
  { table: "poFiles", field: "storageId" },
  { table: "spruceAccounts", field: "catalogId" },
  { table: "taskEvidence", field: "storageId" },
  { table: "workOrderFiles", field: "storageId" },
];

// What the listed tables share. TypeScript cannot see a common "storage" index
// through a union of table names, so the loop below casts to this.
type StorageIndexQuery = {
  withIndex(
    name: "storage",
    range: (q: {
      eq(field: string, value: Id<"_storage">): unknown;
    }) => unknown,
  ): { take(n: number): Promise<{ _id: string }[]> };
};

/**
 * Tells whether any record other than `except` still refers to a blob.
 *
 * @param ctx - Query or mutation context.
 * @param storageId - The blob.
 * @param except - Id of a row to ignore, such as the upload being committed.
 * @returns True when another row in {@link STORAGE_REFERENCES} refers to it.
 */
export async function storageReferenced(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  except?: string,
): Promise<boolean> {
  for (const { table, field } of STORAGE_REFERENCES) {
    // Two rows suffice: at most one of them is `except`.
    const rows = await (ctx.db.query(table) as unknown as StorageIndexQuery)
      .withIndex("storage", (q) => q.eq(field, storageId))
      .take(2);
    if (rows.some((row) => row._id !== except)) return true;
  }
  return false;
}
