import type { TaskCard } from "./taskCards";

export function taskCardZone(
  card: Pick<TaskCard, "description" | "applicability">,
): string {
  const descriptionZone = card.description
    .match(/\bzones?\s*:\s*([^\]\r\n.;]+)/i)?.[1]
    .trim();
  return (
    descriptionZone ||
    card.applicability.match(/^\s*Zone:\s*([^\r\n]*)/im)?.[1].trim() ||
    ""
  );
}
