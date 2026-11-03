import { it, expect } from "vitest";
import { templateDeletionFixture } from "../../tests/fixtures/templateDeletion";
import {
  deleteInspectionTemplates,
  templateDeletionPreview,
} from "./deleteInspectionTemplates";
it("deletes templates and reusable cards together but preserves schedules and independent jobs", () => {
  const { s, template, keep, task, job } = templateDeletionFixture();
  s.taskEvidence = [
    {
      uuid: "attachment",
      taskCardUuid: task.uuid,
      name: "photo",
      size: 1,
      uploadedAt: 0,
      url: "blob:demo",
      category: "photo",
    },
  ];
  const preview = templateDeletionPreview(s, [template.uuid]);
  expect(preview.taskCards.map((t) => t.uuid)).toEqual([task.uuid]);
  deleteInspectionTemplates(s, preview);
  expect(s.inspectionTemplates!.map((t) => t.uuid)).toEqual([keep.uuid]);
  expect(s.taskCards).toEqual([job]);
  expect(s.taskEvidence).toEqual([]);
  expect(s.inspections.some((i) => i.uuid === task.inspectionUuid)).toBe(true);
});
it("blocks stale previews, missing permissions, foreign templates and surviving prerequisites without partial deletion", () => {
  const f = templateDeletionFixture(),
    command = JSON.parse(
      JSON.stringify(templateDeletionPreview(f.s, [f.template.uuid])),
    );
  f.task.version++;
  expect(() => deleteInspectionTemplates(f.s, command)).toThrow("changed");
  expect(f.s.inspectionTemplates).toHaveLength(2);
  f.task.version--;
  f.job.prerequisiteUuids = [f.task.uuid];
  expect(() => deleteInspectionTemplates(f.s, command)).toThrow("prerequisite");
  f.job.prerequisiteUuids = [];
  f.template.programUuid = "foreign";
  expect(() => deleteInspectionTemplates(f.s, command)).toThrow("unavailable");
  f.template.programUuid = "demo-program";
  f.s.user.isAdmin = false;
  f.s.user.groupIds = [];
  expect(() => deleteInspectionTemplates(f.s, command)).toThrow("permission");
});
it("refuses a newly added associated card not included in the confirmed selection", () => {
  const { s, template, task } = templateDeletionFixture();
  const command = JSON.parse(
    JSON.stringify(templateDeletionPreview(s, [template.uuid])),
  );
  s.taskCards!.push({ ...task, uuid: crypto.randomUUID() });
  expect(() => deleteInspectionTemplates(s, command)).toThrow("changed");
  expect(s.inspectionTemplates).toHaveLength(2);
});

it("requires aircraft maintenance access for the full cascade and includes subsequently imported parent tasks", () => {
  const { s, template, task } = templateDeletionFixture();
  s.taskCards!.push({
    ...task,
    uuid: crypto.randomUUID(),
    sourceKey: "task-csv:later-import",
  });
  expect(templateDeletionPreview(s, [template.uuid]).taskCards).toHaveLength(2);
  s.user.isAdmin = false;
  s.user.groupIds = ["restricted-maintenance"];
  s.groups.push({
    id: "restricted-maintenance",
    name: "Restricted maintenance",
    programUuid: "demo-program",
    aircraftIds: [s.aircraft[1].uuid],
    permissions: ["read", "maintenance"],
  });
  expect(() => templateDeletionPreview(s, [template.uuid])).toThrow(
    "every aircraft",
  );
});
