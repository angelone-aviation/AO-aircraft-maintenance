import { z } from "zod";

export const defaultLogbookPhrases = [
  "Performed",
  "Inspected",
  "Repaired",
  "Complied with",
  "Installed",
  "Removed",
  "Updated",
];
export const logbookPhrasesSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(100)
  .refine(
    (phrases) =>
      new Set(phrases.map((p) => p.toLowerCase())).size === phrases.length,
    "Remove duplicate phrases.",
  );
export const logbookSelectionFields = {
  includeInLogbook: z.boolean().optional(),
  logbookPhrase: z.string().trim().min(1).max(200).optional(),
};
export function logbookWorkLine(
  taskNumber: string | number,
  phrase: string | undefined,
  description: string,
  reference: string,
) {
  const wording = phrase || "Performed";
  const action = defaultLogbookPhrases.includes(wording)
    ? wording.toLowerCase()
    : wording;
  return `Task #${taskNumber} ${description.trim()}: ${action} IAW ${reference.trim() || "Standard Practice found in AC43.13"}`;
}
