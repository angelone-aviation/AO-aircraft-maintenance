import { z } from "zod";
import { can, type Snapshot } from "./model";
import { ownsActive, programPermission } from "./programs";
const versioned = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
});
export const deleteTemplatesSchema = z.object({
  templates: z.array(versioned).min(1).max(100),
  taskCards: z.array(versioned).max(10000),
});
export type DeleteTemplatesInput = z.infer<typeof deleteTemplatesSchema>;
export function templateDeletionPreview(s: Snapshot, uuids: string[]) {
  const ids = new Set(uuids);
  if (!ids.size || ids.size !== uuids.length || ids.size > 100)
    throw new Error("Select between 1 and 100 distinct templates.");
  if (!programPermission(s, "maintenance"))
    throw new Error("Maintenance permission is required to delete templates.");
  const templates = (s.inspectionTemplates ?? []).filter((t) =>
    ids.has(t.uuid),
  );
  if (
    templates.length !== ids.size ||
    templates.some((t) => !ownsActive(s, t.programUuid))
  )
    throw new Error(
      "A selected template is unavailable in this Flight Program. Refresh the list.",
    );
  const parentKeys = new Set(
    templates.flatMap((t) => [
      `template:${t.uuid}:initial`,
      `template:${t.uuid}:recurring`,
    ]),
  );
  const inspections = new Set(
    s.inspections
      .filter((i) => i.sourceKey && parentKeys.has(i.sourceKey))
      .map((i) => i.uuid),
  );
  const requirements = new Set(
    (s.management ?? [])
      .filter(
        (r) =>
          r.kind === "componentRequirement" &&
          r.sourceKey &&
          parentKeys.has(r.sourceKey),
      )
      .map((r) => r.uuid),
  );
  const taskCards = (s.taskCards ?? []).filter(
    (t) =>
      !t.workOrderUuid &&
      (inspections.has(t.inspectionUuid) ||
        requirements.has(t.requirementUuid) ||
        [...parentKeys].some((key) => t.sourceKey?.startsWith(`${key}:task:`))),
  );
  if (taskCards.some((t) => !can(s, t.aircraftUuid, "maintenance")))
    throw new Error(
      "Maintenance access to every aircraft with associated job cards is required. Ask a Flight Program administrator to delete these templates.",
    );
  const taskIds = new Set(taskCards.map((t) => t.uuid));
  const dependent = (s.taskCards ?? []).find(
    (t) =>
      !taskIds.has(t.uuid) && t.prerequisiteUuids.some((id) => taskIds.has(id)),
  );
  if (dependent)
    throw new Error(
      `Job card “${dependent.title}” depends on a card selected for deletion. Remove its prerequisite links before deleting these templates.`,
    );
  return { templates, taskCards };
}
export function deleteInspectionTemplates(
  s: Snapshot,
  raw: DeleteTemplatesInput,
) {
  const input = deleteTemplatesSchema.parse(raw);
  const result = templateDeletionPreview(
    s,
    input.templates.map((t) => t.uuid),
  );
  const same = (
    a: { uuid: string; version: number }[],
    b: { uuid: string; version: number }[],
  ) =>
    a.length === b.length &&
    new Set(a.map((x) => x.uuid)).size === a.length &&
    a.every((x) => b.some((y) => y.uuid === x.uuid && y.version === x.version));
  if (
    !same(input.templates, result.templates) ||
    !same(input.taskCards, result.taskCards)
  )
    throw new Error(
      "Templates or associated job cards changed. Reopen the deletion preview before continuing.",
    );
  const templates = new Set(result.templates.map((t) => t.uuid)),
    tasks = new Set(result.taskCards.map((t) => t.uuid));
  s.inspectionTemplates = s.inspectionTemplates?.filter(
    (t) => !templates.has(t.uuid),
  );
  s.taskCards = s.taskCards?.filter((t) => !tasks.has(t.uuid));
  s.taskEvidence = s.taskEvidence?.filter((e) => !tasks.has(e.taskCardUuid));
  return result;
}
