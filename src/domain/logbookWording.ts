/**
 * Responsibility: Logbook-entry wording: the phrases users pick from, a task's
 *   logbook choice, and the work line a selected task adds to the entry.
 * Layer: Domain. Pure zod schemas and functions; no I/O, no React.
 * Dependencies: zod. No internal imports.
 */
import { z } from "zod";

const PHRASE_MAX_LENGTH = 200;
const DEFAULT_PHRASE = "Performed";

// With no maintenance data named, the line cites the FAA's acceptable methods
// and practices (AC 43.13, under 14 CFR 43.13(a)).
const STANDARD_PRACTICE_REFERENCE = "Standard Practice found in AC43.13";

const phraseSchema = z.string().trim().min(1).max(PHRASE_MAX_LENGTH);

/**
 * The standard phrases, in menu order: the list a user starts with, and the
 * phrases {@link logbookWorkLine} writes in lowercase.
 */
export const defaultLogbookPhrases = [
  DEFAULT_PHRASE,
  "Inspected",
  "Repaired",
  "Complied with",
  "Installed",
  "Removed",
  "Updated",
];

/**
 * A user's saved phrase list: 1 to 100 trimmed phrases of up to 200
 * characters, unique ignoring case.
 *
 * @throws {z.ZodError} From `parse()` on an empty or over-long list or phrase,
 *   and "Remove duplicate phrases." on a repeat.
 */
export const logbookPhrasesSchema = z
  .array(phraseSchema)
  .min(1)
  .max(100)
  .refine(
    (phrases) =>
      new Set(phrases.map((p) => p.toLowerCase())).size === phrases.length,
    "Remove duplicate phrases.",
  );

/**
 * Schema fields for a task's logbook choice: whether its completed work goes
 * into the logbook entry, and the phrase (trimmed, up to 200 characters).
 */
export const logbookSelectionFields = {
  includeInLogbook: z.boolean().optional(),
  logbookPhrase: phraseSchema.optional(),
};

/**
 * Writes the logbook-entry line for one task. A standard phrase, as listed, is
 * lowercased; any other phrase is kept as written.
 *
 * @param taskNumber - The task's work-order position, or its card number.
 * @param phrase - The chosen phrase; "Performed" when blank or missing.
 * @param description - The work done; trimmed.
 * @param reference - The maintenance data used; trimmed, and AC 43.13
 *   standard practice when blank.
 * @returns "Task #<number> <description>: <phrase> IAW <reference>".
 */
export function logbookWorkLine(
  taskNumber: string | number,
  phrase: string | undefined,
  description: string,
  reference: string,
): string {
  const wording = phrase || DEFAULT_PHRASE;
  const action = defaultLogbookPhrases.includes(wording)
    ? wording.toLowerCase()
    : wording;
  const source = reference.trim() || STANDARD_PRACTICE_REFERENCE;
  return `Task #${taskNumber} ${description.trim()}: ${action} IAW ${source}`;
}
