/**
 * Responsibility: Which of an AD's required actions a work order can take on.
 * Layer: Domain. Pure functions over the snapshot; no I/O, no React.
 * Dependencies: src/domain/airworthiness.ts, src/domain/model.ts (types).
 */
import { adStatus, adTaskStatus, type AD, type ADTask } from "./airworthiness";
import type { Snapshot } from "./model";

/** The applicability decisions under which an AD's actions are tracked. */
export const TRACKED_AD_APPLICABILITY: readonly AD["applicability"][] = [
  "Applicable",
  "Previously Complied With (PCW)",
];

/** The action and AD statuses with something due for a work order to do. */
export const OPEN_AD_STATUSES: readonly string[] = [
  "Scheduled",
  "Due soon",
  "Overdue",
];

/**
 * The AD's actions a work order can take on: those Scheduled, Due soon or
 * Overdue, and none while the AD is under review, not tracked, or on a
 * removed component.
 *
 * @param s - The aircraft and the program's components.
 * @param r - The AD.
 * @param taskUuid - Only this action, when given.
 * @returns The actions, in the AD's order.
 */
export function adWorkOrderTasks(
  s: Snapshot,
  r: AD,
  taskUuid?: string,
): ADTask[] {
  if (
    r.reviewRequired ||
    !TRACKED_AD_APPLICABILITY.includes(r.applicability) ||
    adStatus(s, r) === "Removed component"
  )
    return [];
  return r.tasks.filter(
    (task) =>
      (!taskUuid || task.uuid === taskUuid) &&
      OPEN_AD_STATUSES.includes(adTaskStatus(s, r, task)),
  );
}
