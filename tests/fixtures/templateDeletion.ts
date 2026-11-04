/**
 * Responsibility: A snapshot for deleting inspection templates: one template
 *   in use, one to keep, and a work-order job card copied from it.
 * Layer: Test. Fixture over the demo seed and the domain appliers.
 * Dependencies: src/data/demo (demoSnapshot), src/domain/inspectionTemplates
 *   (emptyTemplate), src/domain/activateTemplate.
 */
import { demoSnapshot } from "../../src/data/demo";
import { emptyTemplate } from "../../src/domain/inspectionTemplates";
import { activateTemplate } from "../../src/domain/activateTemplate";

const HOUR_SECONDS = 3600;

/**
 * Builds the demo snapshot with "Delete phase" (100 hours, one task) active
 * as a recurring inspection on the first aircraft, an empty "Keep phase", and
 * a completed work-order card whose source is the inspection's job card.
 * @returns The snapshot `s`, the `template` to delete and the one to `keep`,
 *   the inspection's job card (`task`) and its completed copy (`job`), both
 *   in `s.taskCards`.
 */
export function templateDeletionFixture() {
  const s = demoSnapshot(),
    a = s.aircraft[0];
  const template = {
    ...emptyTemplate(),
    version: 1,
    programUuid: a.programUuid,
    name: "Delete phase",
    hours: 100,
    applicability: {
      kind: "aircraft" as const,
      manufacturer: a.make,
      model: a.model,
      partNumber: "",
    },
    tasks: [
      { itemCode: "A1", instruction: "Inspect seal", applicability: "All" },
    ],
  };
  const keep = {
    ...template,
    uuid: crypto.randomUUID(),
    name: "Keep phase",
    tasks: [],
  };
  s.inspectionTemplates = [template, keep];
  const activated = activateTemplate(s, {
    templateUuid: template.uuid,
    templateVersion: 1,
    targetUuid: a.uuid,
    mode: "recurring",
    description: "Phase inspection",
    lastSeconds: 2200 * HOUR_SECONDS,
    reviewed: true,
  });
  const job = {
    ...activated.tasks[0],
    uuid: crypto.randomUUID(),
    title: "Independent job card",
    workOrderUuid: crypto.randomUUID(),
    sourceTaskCardUuid: activated.tasks[0].uuid,
    status: "completed" as const,
  };
  s.taskCards!.push(job);
  return { s, template, keep, task: activated.tasks[0], job };
}
