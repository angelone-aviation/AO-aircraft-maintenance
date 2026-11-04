/**
 * Responsibility: The rules every attachment obeys: the per-record cap, and
 *   what new evidence does to a signed job card.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./rejection, ./taskCards (types).
 *
 * Each adapter still stores the file itself; these rules decide whether a
 * record may take it and what the record becomes, once for both (T3).
 */
import { Rejection } from "./rejection";
import type { TaskCard } from "./taskCards";

/**
 * Most attachments one record may hold. A caller needs to count at most this
 * many (the server reads them with `.take(MAX_ATTACHMENTS)`).
 */
export const MAX_ATTACHMENTS = 25;

/**
 * Refuses another attachment on a record that already holds the maximum.
 *
 * @param count - How many attachments the record holds now.
 * @throws {Rejection} "This record already has the maximum of 25
 *   attachments."
 */
export function assertAttachmentRoom(count: number): void {
  if (count >= MAX_ATTACHMENTS)
    throw new Rejection(
      `This record already has the maximum of ${MAX_ATTACHMENTS} attachments.`,
    );
}

/**
 * The job card once new evidence is filed on it. Evidence is part of what was
 * signed, so every signoff is cleared and the card takes a new version.
 *
 * @param card - The card the evidence is filed on; left unchanged.
 * @param now - When the evidence was filed.
 * @returns A copy with no technician, inspection or step signoffs, at
 *   `version + 1` and `updatedAt` = `now`; every other field, and the key
 *   order, as on `card`.
 */
export function withNewEvidence(card: TaskCard, now: number): TaskCard {
  return {
    ...card,
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
    version: card.version + 1,
    updatedAt: now,
  };
}
