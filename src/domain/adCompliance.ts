import type { AD, ADCompliance } from "./airworthiness";

/** The compliance history as corrected: each correction takes the place of
 * the entry it corrects, the latest correction winning. The originals stay
 * in `history` (ADR-0005). */
export function effectiveCompliance(r: AD): ADCompliance[] {
  const latest = new Map<string, ADCompliance>();
  for (const h of r.history) if (h.corrects) latest.set(h.corrects, h);
  return r.history
    .filter((h) => !h.corrects)
    .map((h) => latest.get(h.uuid) ?? h);
}
/** The latest compliance on one required action, as corrected. */
export const lastCompliance = (r: AD, taskUuid: string) =>
  effectiveCompliance(r)
    .filter((h) => h.taskUuid === taskUuid)
    .at(-1);
