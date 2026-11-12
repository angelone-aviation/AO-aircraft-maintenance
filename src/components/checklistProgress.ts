/**
 * Responsibility: Counts a user's checklist marks into the totals the
 *   checklist reader shows for a whole checklist set.
 * Layer: UI. Pure functions; no React, no storage.
 * Dependencies: src/domain/checklists.ts (types).
 */
import type { ChecklistDocument } from "../domain/checklists";

/** A user's marks on a checklist set's entries, by entry objectId. */
export type Progress = Record<string, "checked" | "skipped">;

/** How many of a set's checks are checked, skipped and still open. */
export type SetTotals = {
  checked: number;
  skipped: number;
  open: number;
  total: number;
};

/**
 * Counts a set's checks by mark, across every category and list. Comments
 * are not checks, and marks on entries the set no longer holds are ignored.
 *
 * @param document - The checklist set.
 * @param progress - The user's marks.
 * @returns Totals where `checked + skipped + open` equals `total`.
 */
export function setTotals(
  document: ChecklistDocument,
  progress: Progress,
): SetTotals {
  const checks = document.payload.groups
    .flatMap((category) => category.items)
    .flatMap((group) => group.items)
    .flatMap((list) => list.items)
    .filter((item) => item.type !== "comment");
  const count = (mark: Progress[string]) =>
    checks.filter((item) => progress[item.objectId] === mark).length;
  const checked = count("checked");
  const skipped = count("skipped");
  return {
    checked,
    skipped,
    open: checks.length - checked - skipped,
    total: checks.length,
  };
}
