/**
 * Responsibility: Which job cards leave a work order with the work items
 *   removed from it.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, taskCards.ts and workOrders.ts (types),
 *   workOrderCards.ts, rejection.ts.
 */
import type { Snapshot } from "./model";
import type { TaskCard } from "./taskCards";
import { taskCardMatchesWorkItem } from "./workOrderCards";
import type { WorkTask } from "./workOrders";
import { Rejection } from "./rejection";

/**
 * Finds the job cards that go with the work items removed from an order.
 *
 * @param s - The snapshot.
 * @param orderUuid - The work order.
 * @param removed - The items being removed.
 * @param remaining - The items the order keeps.
 * @returns The order's cards, in snapshot order, that match a removed item and
 *   no remaining one.
 * @throws {Rejection} "Another job card requires one of these cards. Remove
 *   the prerequisite link before removing this task." when any other card, on
 *   any order, lists one of them as a prerequisite.
 */
export function removedTaskCards(
  s: Snapshot,
  orderUuid: string,
  removed: WorkTask[],
  remaining: WorkTask[],
): TaskCard[] {
  const matchesAny = (card: TaskCard, tasks: WorkTask[]) =>
    tasks.some((task) => taskCardMatchesWorkItem(card, task));
  const cards = (s.taskCards ?? []).filter(
    (card) =>
      card.workOrderUuid === orderUuid &&
      matchesAny(card, removed) &&
      !matchesAny(card, remaining),
  );
  assertNotPrerequisites(s, new Set(cards.map((card) => card.uuid)));
  return cards;
}

function assertNotPrerequisites(s: Snapshot, ids: Set<string>) {
  const required = s.taskCards?.some(
    (card) =>
      !ids.has(card.uuid) && card.prerequisiteUuids.some((id) => ids.has(id)),
  );
  if (required)
    throw new Rejection(
      "Another job card requires one of these cards. Remove the prerequisite link before removing this task.",
    );
}
