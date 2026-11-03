import type { QueryCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
// Every table field that holds a file storage id, each with a "storage" index.
// manuals.test.ts checks this list against the schema, so a new file table
// cannot be missed by code that deletes blobs no record refers to.
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
type StorageIndexQuery = {
  withIndex(
    name: "storage",
    range: (q: {
      eq(field: string, value: Id<"_storage">): unknown;
    }) => unknown,
  ): { take(n: number): Promise<{ _id: string }[]> };
};
// True when any record other than `except` refers to the blob.
export async function storageReferenced(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  except?: string,
) {
  for (const { table, field } of STORAGE_REFERENCES) {
    const rows = await (ctx.db.query(table) as unknown as StorageIndexQuery)
      .withIndex("storage", (q) => q.eq(field, storageId))
      .take(2);
    if (rows.some((row) => row._id !== except)) return true;
  }
  return false;
}
