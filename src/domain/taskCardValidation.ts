import { ZodError } from "zod";
import { localDate, type Snapshot } from "./model";
import {
  saveTaskCard,
  taskCardFieldsSchema,
  type TaskCard,
  type TaskCardFields,
} from "./taskCards";

const labels: Record<string, string> = {
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
export function taskCardValidationMessages(error: unknown): string[] {
  if (error instanceof ZodError)
    return error.issues.map((issue) => {
      const path = issue.path;
      const prefix =
        path[0] === "steps"
          ? `Step ${Number(path[1]) + 1}: `
          : path[0] === "partsUsed"
            ? `Part ${Number(path[1]) + 1}: `
            : "";
      const key = String(path.at(-1) ?? "field");
      const field = labels[key] ?? key.replace(/([A-Z])/g, " $1");
      if (issue.code === "too_small" && issue.origin === "string")
        return `${prefix}${field} is required.`;
      return `${prefix}${field}: ${issue.message}`;
    });
  return error instanceof Error
    ? error.message.split("\n")
    : ["Unable to save the job card."];
}
export function taskCardSaveWarnings(
  s: Snapshot,
  uuid: string,
  fields: TaskCardFields,
  initial?: TaskCard,
): string[] {
  const parsed = taskCardFieldsSchema.safeParse(fields);
  if (!parsed.success) return taskCardValidationMessages(parsed.error);
  try {
    // Use the real save rules on an isolated copy; no preview writes are committed.
    saveTaskCard(structuredClone(s), {
      action: "save",
      uuid,
      version: initial?.version ?? 0,
      fields: parsed.data,
    });
    return [];
  } catch (error) {
    return taskCardValidationMessages(error);
  }
}
export function taskCardSigningWarnings(
  fields: TaskCardFields,
  dirty: boolean,
  initial?: TaskCard,
): string[] {
  const warnings: string[] = [];
  if (fields.completionDate > localDate())
    warnings.push("Completion date cannot be in the future.");
  if (fields.status === "draft")
    warnings.push(
      "Change Task status to Ready or In progress and save before signing.",
    );
  if (!initial) warnings.push("Save the job card before signing.");
  else if (dirty)
    warnings.push(
      "Save your changes before signing. Changes clear existing signoffs.",
    );
  return warnings;
}
