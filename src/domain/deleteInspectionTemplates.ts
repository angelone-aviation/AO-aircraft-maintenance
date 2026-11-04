/**
 * Responsibility: Deleting inspection templates together with the reusable
 *   job-card templates they created, after a confirmed preview, with their
 *   change-log entries.
 * Layer: Domain. Zod schema, rules and an applier on a working snapshot; no
 *   I/O, no React.
 * Dependencies: zod, src/domain/model.ts, programs.ts, rejection.ts,
 *   changeLog.ts.
 *
 * The schedules and component requirements a template created stay, as do
 * job cards copied into work orders (docs/maintenance-csv-import.md).
 */
import { z } from "zod";
import { auditEntry } from "./changeLog";
import { can, type Snapshot } from "./model";
import { ownsActive, programPermission } from "./programs";
import { Rejection } from "./rejection";

/** Most templates one deletion may select. */
export const MAX_TEMPLATES_PER_DELETION = 100;

type Versioned = { uuid: string; version: number };

const versioned = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
});

/** A confirmed deletion: each record at the version the preview showed. */
export const deleteTemplatesSchema = z.object({
  templates: z.array(versioned).min(1).max(MAX_TEMPLATES_PER_DELETION),
  taskCards: z.array(versioned).max(10000),
});

/** A parsed {@link deleteTemplatesSchema} deletion. */
export type DeleteTemplatesInput = z.infer<typeof deleteTemplatesSchema>;

/**
 * Lists what deleting inspection templates would remove.
 *
 * @param s - The snapshot.
 * @param uuids - The templates to delete.
 * @returns The templates, and the job-card templates (not on a work order)
 *   tied to them, in snapshot order.
 * @throws {Rejection} "Select between 1 and 100 distinct templates.";
 *   "Maintenance permission is required to delete templates."; "A selected
 *   template is unavailable in this Flight Program. Refresh the list.";
 *   "Maintenance access to every aircraft with associated job cards is
 *   required. …"; "Job card “<title>” depends on a card selected for
 *   deletion. …" for a card that stays.
 */
export function templateDeletionPreview(s: Snapshot, uuids: string[]) {
  const templates = selectTemplates(s, uuids);
  const taskCards = findTemplateTaskCards(s, templates);
  assertTaskCardsDeletable(s, taskCards);
  return { templates, taskCards };
}

/**
 * Deletes inspection templates and their job-card templates, with the cards'
 * evidence, from a working snapshot, and adds a "taskCard.deletedWithTemplate"
 * entry for each card, then an "inspectionTemplate.deleted" entry for each
 * template, holding the record before.
 *
 * @param s - The working snapshot; changed in place.
 * @param raw - The confirmed deletion.
 * @returns The preview it matched.
 * @throws {Rejection} "Templates or associated job cards changed. Reopen the
 *   deletion preview before continuing." when the preview now differs in any
 *   record or version; otherwise as {@link templateDeletionPreview}.
 */
export function deleteInspectionTemplates(
  s: Snapshot,
  raw: DeleteTemplatesInput,
) {
  const input = deleteTemplatesSchema.parse(raw);
  const result = templateDeletionPreview(
    s,
    input.templates.map((t) => t.uuid),
  );
  if (
    !matchesVersions(input.templates, result.templates) ||
    !matchesVersions(input.taskCards, result.taskCards)
  )
    throw new Rejection(
      "Templates or associated job cards changed. Reopen the deletion preview before continuing.",
    );
  const templates = new Set(result.templates.map((t) => t.uuid));
  const tasks = new Set(result.taskCards.map((t) => t.uuid));
  s.inspectionTemplates = s.inspectionTemplates?.filter(
    (t) => !templates.has(t.uuid),
  );
  s.taskCards = s.taskCards?.filter((t) => !tasks.has(t.uuid));
  s.taskEvidence = s.taskEvidence?.filter((e) => !tasks.has(e.taskCardUuid));
  recordDeletion(s, result);
  return result;
}

function selectTemplates(s: Snapshot, uuids: string[]) {
  const ids = new Set(uuids);
  if (
    !ids.size ||
    ids.size !== uuids.length ||
    ids.size > MAX_TEMPLATES_PER_DELETION
  )
    throw new Rejection("Select between 1 and 100 distinct templates.");
  if (!programPermission(s, "maintenance"))
    throw new Rejection(
      "Maintenance permission is required to delete templates.",
    );
  const templates = (s.inspectionTemplates ?? []).filter((t) =>
    ids.has(t.uuid),
  );
  if (
    templates.length !== ids.size ||
    templates.some((t) => !ownsActive(s, t.programUuid))
  )
    throw new Rejection(
      "A selected template is unavailable in this Flight Program. Refresh the list.",
    );
  return templates;
}

// Activating a template stamps its schedules "template:<uuid>:<mode>" and its
// job-card templates that key plus ":task:<n>". A card counts through its
// schedule too, so cards added after activation go with it.
function findTemplateTaskCards(s: Snapshot, templates: { uuid: string }[]) {
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
  return (s.taskCards ?? []).filter(
    (t) =>
      !t.workOrderUuid &&
      (inspections.has(t.inspectionUuid) ||
        requirements.has(t.requirementUuid) ||
        [...parentKeys].some((key) => t.sourceKey?.startsWith(`${key}:task:`))),
  );
}

function assertTaskCardsDeletable(
  s: Snapshot,
  taskCards: { uuid: string; aircraftUuid: string }[],
) {
  if (taskCards.some((t) => !can(s, t.aircraftUuid, "maintenance")))
    throw new Rejection(
      "Maintenance access to every aircraft with associated job cards is required. Ask a Flight Program administrator to delete these templates.",
    );
  const taskIds = new Set(taskCards.map((t) => t.uuid));
  const dependent = (s.taskCards ?? []).find(
    (t) =>
      !taskIds.has(t.uuid) && t.prerequisiteUuids.some((id) => taskIds.has(id)),
  );
  if (dependent)
    throw new Rejection(
      `Job card “${dependent.title}” depends on a card selected for deletion. Remove its prerequisite links before deleting these templates.`,
    );
}

function recordDeletion(
  s: Snapshot,
  { templates, taskCards }: ReturnType<typeof templateDeletionPreview>,
) {
  for (const card of taskCards)
    s.audit.unshift(
      auditEntry(s, {
        action: "taskCard.deletedWithTemplate",
        entityUuid: card.uuid,
        aircraftUuid: card.aircraftUuid,
        reason: "Deleted with its inspection template.",
        before: card,
      }),
    );
  for (const template of templates)
    s.audit.unshift(
      auditEntry(s, {
        action: "inspectionTemplate.deleted",
        entityUuid: template.uuid,
        reason: "Deleted template and associated reusable job cards.",
        before: template,
      }),
    );
}

// Same records at the same versions, without duplicates in the confirmation.
function matchesVersions(confirmed: Versioned[], current: Versioned[]) {
  return (
    confirmed.length === current.length &&
    new Set(confirmed.map((x) => x.uuid)).size === confirmed.length &&
    confirmed.every((x) =>
      current.some((y) => y.uuid === x.uuid && y.version === x.version),
    )
  );
}
