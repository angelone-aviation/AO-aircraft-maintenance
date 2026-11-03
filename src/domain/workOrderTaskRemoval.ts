import type { Snapshot } from "./model";
import type { TaskCard } from "./taskCards";
import { taskCardMatchesWorkItem } from "./workOrderCards";
import type { WorkTask } from "./workOrders";

export function removedTaskCards(
  s: Snapshot,
  orderUuid: string,
  removed: WorkTask[],
  remaining: WorkTask[],
): TaskCard[] {
  const cards = (s.taskCards ?? []).filter(
    (card) =>
      card.workOrderUuid === orderUuid &&
      removed.some((task) => taskCardMatchesWorkItem(card, task)) &&
      !remaining.some((task) => taskCardMatchesWorkItem(card, task)),
  );
  const ids = new Set(cards.map((card) => card.uuid));
  if (
    s.taskCards?.some(
      (card) =>
        !ids.has(card.uuid) && card.prerequisiteUuids.some((id) => ids.has(id)),
    )
  )
    throw new Error(
      "Another job card requires one of these cards. Remove the prerequisite link before removing this task.",
    );
  return cards;
}
