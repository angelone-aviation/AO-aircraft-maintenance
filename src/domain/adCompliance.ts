/**
 * Responsibility: An AD's compliance history as corrected.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/airworthiness.ts (types).
 *
 * Kept out of airworthiness.ts, which re-exports it, so modules that
 * airworthiness.ts imports can use it without an import cycle.
 */
import type { AD, ADCompliance } from "./airworthiness";

/**
 * The compliance history as corrected: each correction takes the place of
 * the entry it corrects, the latest correction winning. The originals stay
 * in `history` (ADR-0005).
 *
 * @param r - The AD.
 * @returns One entry per original, in history order: its latest correction,
 *   or the original itself.
 */
export function effectiveCompliance(r: AD): ADCompliance[] {
  const latest = new Map<string, ADCompliance>();
  for (const h of r.history) if (h.corrects) latest.set(h.corrects, h);
  return r.history
    .filter((h) => !h.corrects)
    .map((h) => latest.get(h.uuid) ?? h);
}

/**
 * The latest compliance on one required action, as corrected.
 *
 * @param r - The AD.
 * @param taskUuid - The required action.
 * @returns The last such entry in history order, or undefined if none.
 */
export const lastCompliance = (r: AD, taskUuid: string) =>
  effectiveCompliance(r)
    .filter((h) => h.taskUuid === taskUuid)
    .at(-1);
