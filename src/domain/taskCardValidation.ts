/**
 * Responsibility: The warnings a job card form shows before saving and before
 *   signing.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: zod; src/domain/model.ts, taskCards.ts.
 */
import { ZodError } from "zod";
import { localDate, type Snapshot } from "./model";
import {
  saveTaskCard,
  taskCardFieldsSchema,
  type TaskCard,
  type TaskCardFields,
} from "./taskCards";

// Fields not listed are named from their key: "maintenanceReference" reads
// "maintenance Reference".
const FIELD_LABELS: Record<string, string> = {
  aircraftUuid: "Aircraft",
  title: "Title",
  cardNumber: "Card number",
  completionDate: "Completion date",
  instruction: "Instruction",
  partNumber: "Part number",
  quantity: "Quantity",
  estimatedLabor: "Estimated labor",
  actualLabor: "Actual labor",
  referenceDate: "Reference date",
  stockUuid: "Stock item",
  locationUuid: "Inventory location",
};

/**
 * The messages a job card form shows for a refused save.
 *
 * @param error - What the parse or save threw.
 * @returns For a ZodError, one message per issue naming the field, prefixed
 *   "Step N: " or "Part N: " inside those lists ("<Field> is required." for
 *   an empty text); for another Error, its message lines; else "Unable to
 *   save the job card."
 */
export function taskCardValidationMessages(error: unknown): string[] {
  if (error instanceof ZodError) return error.issues.map(describeIssue);
  return error instanceof Error
    ? error.message.split("\n")
    : ["Unable to save the job card."];
}

/**
 * Previews a job card save with the real save rules, on a copy.
 *
 * @param s - The snapshot; never changed.
 * @param uuid - The card's id.
 * @param fields - The form's fields.
 * @param initial - The stored card, whose version the save would replace.
 * @returns The messages the save would refuse with; [] if it would succeed.
 */
export function taskCardSaveWarnings(
  s: Snapshot,
  uuid: string,
  fields: TaskCardFields,
  initial?: TaskCard,
): string[] {
  const parsed = taskCardFieldsSchema.safeParse(fields);
  if (!parsed.success) return taskCardValidationMessages(parsed.error);
  try {
    saveTaskCard(structuredClone(s), {
      action: "save",
      uuid,
      version: initial?.version ?? 0,
      fields: parsed.data,
    });
    return [];
  } catch (error) {
    // A refused save is the preview's answer, shown to the user as warnings.
    return taskCardValidationMessages(error);
  }
}

/**
 * Why the form's job card cannot be signed yet.
 *
 * @param fields - The form's fields.
 * @param dirty - Whether the form has unsaved changes.
 * @param initial - The stored card; undefined before the first save.
 * @returns In order: a future completion date; then, for an unsaved card,
 *   one save-first warning (naming the status change for a draft); else a
 *   draft status and unsaved changes; [] when none applies. A blank
 *   completion date is not warned here; the server refuses the signoff.
 */
export function taskCardSigningWarnings(
  fields: TaskCardFields,
  dirty: boolean,
  initial?: TaskCard,
): string[] {
  const warnings: string[] = [];
  if (fields.completionDate > localDate())
    warnings.push("Completion date cannot be in the future.");
  // Task status stays locked until the first save, so a new draft card is
  // told to save before it is told to change the status.
  if (!initial) {
    warnings.push(
      fields.status === "draft"
        ? "Save the job card first: Task status unlocks after the first save. Then change it to Ready or In progress and save again before signing."
        : "Save the job card before signing.",
    );
    return warnings;
  }
  if (fields.status === "draft")
    warnings.push(
      "Change Task status to Ready or In progress and save before signing.",
    );
  if (dirty)
    warnings.push(
      "Save your changes before signing. Changes clear existing signoffs.",
    );
  return warnings;
}

function describeIssue(issue: ZodError["issues"][number]) {
  const key = String(issue.path.at(-1) ?? "field");
  const field = FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1");
  const prefix = listItemPrefix(issue.path);
  if (issue.code === "too_small" && issue.origin === "string")
    return `${prefix}${field} is required.`;
  return `${prefix}${field}: ${issue.message}`;
}

function listItemPrefix([list, index]: PropertyKey[]) {
  if (list === "steps") return `Step ${Number(index) + 1}: `;
  if (list === "partsUsed") return `Part ${Number(index) + 1}: `;
  return "";
}
