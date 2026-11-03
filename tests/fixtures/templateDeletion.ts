import { demoSnapshot } from "../../src/data/demo";
import { emptyTemplate } from "../../src/domain/inspectionTemplates";
import { activateTemplate } from "../../src/domain/activateTemplate";
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
    lastSeconds: 2200 * 3600,
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
