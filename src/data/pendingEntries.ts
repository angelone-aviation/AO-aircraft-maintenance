/**
 * Responsibility: Which outbox entries are the signed-in user's, and the file
 *   that saves a copy of them.
 * Layer: Data. Pure functions over the outbox; no I/O, no React.
 * Dependencies: src/domain/model.ts (types).
 *
 * An entry belongs to the user who recorded it: only its author may see,
 * export or sync it, even when several people share one device.
 */
import type { QueuedOperation } from "../domain/model";

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
