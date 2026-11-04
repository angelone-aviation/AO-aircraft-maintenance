/**
 * Responsibility: Pins which outbox entries are the user's and the file that
 *   saves them: its name, its order and its JSON.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/pendingEntries.ts, src/domain/model.ts (types).
 */
import { expect, it } from "vitest";
import type { QueuedOperation } from "../domain/model";
import { ownEntries, pendingEntriesFile } from "./pendingEntries";

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
