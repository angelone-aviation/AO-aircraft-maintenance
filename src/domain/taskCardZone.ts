/**
 * Responsibility: Reads the zone a task card applies to from its free text.
 * Layer: Domain. Pure function; no I/O, no React.
 * Dependencies: ./taskCards (types).
 */
import type { TaskCard } from "./taskCards";

const DESCRIPTION_ZONE = /\bzones?\s*:\s*([^\]\r\n.;]+)/i;
const APPLICABILITY_ZONE_LINE = /^\s*Zone:\s*([^\r\n]*)/im;

/**
 * The card's zone: the text after "Zone:" or "Zones:" anywhere in the
 * description, up to `]`, `.`, `;` or the line end; else the rest of an
 * applicability line that starts with "Zone:". Both ignore case.
 *
 * @param card - The card's description and applicability.
 * @returns The trimmed zone, or "" when neither names one.
 */
export function taskCardZone(
  card: Pick<TaskCard, "description" | "applicability">,
): string {
  const descriptionZone = card.description.match(DESCRIPTION_ZONE)?.[1].trim();
  return (
    descriptionZone ||
    card.applicability.match(APPLICABILITY_ZONE_LINE)?.[1].trim() ||
    ""
  );
}
