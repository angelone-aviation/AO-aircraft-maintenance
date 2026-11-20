/**
 * Responsibility: Which outbox entries are the signed-in user's, how much of
 *   their work has not synced, and the file that saves a copy of them.
 * Layer: Data. Pure functions over the outbox; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), src/data/logbookPhotos.ts.
 *
 * An entry belongs to the user who recorded it: only its author may see,
 * export, sync or discard it, even when several people share one device.
 */
import type { QueuedOperation } from "../domain/model";
import { ownPendingPhotos, type PendingLogbookPhoto } from "./logbookPhotos";

/**
 * The outbox entries `userId` recorded on this device.
 *
 * @param queue - The workspace's outbox, oldest first.
 * @param userId - The signed-in user.
 * @returns Their entries, in outbox order.
 */
export function ownEntries(
  queue: QueuedOperation[],
  userId: string,
): QueuedOperation[] {
  return queue.filter((q) => q.operation.authorId === userId);
}

/**
 * How much of a user's work on this device has not reached the server: what
 * signing out would delete.
 *
 * @param queue - The workspace's outbox.
 * @param photos - The workspace's queued logbook page photos.
 * @param userId - The signed-in user.
 * @returns Counts of their outbox entries and queued photos, refused ones
 *   included.
 */
export function unsyncedItems(
  queue: QueuedOperation[],
  photos: PendingLogbookPhoto[],
  userId: string,
): { entries: number; photos: number } {
  return {
    entries: ownEntries(queue, userId).length,
    photos: ownPendingPhotos(photos, userId).length,
  };
}

/**
 * The JSON file a user saves to keep a copy of their pending entries, from the
 * Sync center or when offline access has expired.
 *
 * @param queue - The workspace's outbox, oldest first.
 * @param userId - The signed-in user.
 * @returns `name` "angel-one-pending-entries.json", and `text`: their
 *   {@link ownEntries} as JSON indented by two spaces.
 */
export function pendingEntriesFile(queue: QueuedOperation[], userId: string) {
  return {
    name: "angel-one-pending-entries.json",
    text: JSON.stringify(ownEntries(queue, userId), null, 2),
  };
}
