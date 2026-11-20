/**
 * Responsibility: Pins which outbox entries are the user's, how much of their
 *   work has not synced, and the file that saves their entries.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/pendingEntries.ts, src/data/logbookPhotos.ts and
 *   src/domain/model.ts (types).
 */
import { expect, it } from "vitest";
import type { QueuedOperation } from "../domain/model";
import type { PendingLogbookPhoto } from "./logbookPhotos";
import {
  ownEntries,
  pendingEntriesFile,
  unsyncedItems,
} from "./pendingEntries";

function report(uuid: string, authorId: string): QueuedOperation {
  return {
    operation: {
      kind: "discrepancy",
      uuid,
      authorId,
      aircraftUuid: "demo-206",
      description: "Oil leak",
    },
    queuedAt: 1,
  };
}

const queue = [
  report("a1", "pilot"),
  report("b1", "other"),
  report("a2", "pilot"),
];

it("keeps only the author's entries, in outbox order", () => {
  expect(ownEntries(queue, "pilot").map((q) => q.operation.uuid)).toEqual([
    "a1",
    "a2",
  ]);
  expect(ownEntries(queue, "nobody")).toEqual([]);
});

it("saves the author's entries as indented JSON under one file name", () => {
  const file = pendingEntriesFile(queue, "pilot");
  expect(file.name).toBe("angel-one-pending-entries.json");
  expect(file.text).toBe(JSON.stringify([queue[0], queue[2]], null, 2));
  expect(file.text).toContain('\n  {\n    "operation": {');
});

it("counts the author's unsynced entries and photos, failed ones included", () => {
  const photo = (authorId: string, error?: string): PendingLogbookPhoto => ({
    key: `f1:${authorId}`,
    aircraftUuid: "demo-206",
    linkedKind: "flight",
    linkedUuid: "f1",
    authorId,
    name: "page.jpg",
    type: "image/jpeg",
    size: 1,
    queuedAt: 1,
    error,
    blob: new Blob(),
  });
  const refused = { ...report("a3", "pilot"), error: "Refused" };
  const photos = [photo("pilot"), photo("other"), photo("pilot", "Refused")];
  expect(unsyncedItems([...queue, refused], photos, "pilot")).toEqual({
    entries: 3,
    photos: 2,
  });
  expect(unsyncedItems(queue, photos, "nobody")).toEqual({
    entries: 0,
    photos: 0,
  });
});
