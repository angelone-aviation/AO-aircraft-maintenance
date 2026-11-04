/**
 * Responsibility: Pins deleting inspection templates with their job-card
 *   templates: what goes, what stays, and each refusal.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/deleteInspectionTemplates.ts, rejection.ts,
 *   tests/fixtures/templateDeletion.ts.
 */
import { it, expect } from "vitest";
import { templateDeletionFixture } from "../../tests/fixtures/templateDeletion";
import {
  deleteInspectionTemplates,
  templateDeletionPreview,
} from "./deleteInspectionTemplates";
import { Rejection } from "./rejection";

function expectRefusal(run: () => unknown, message: string) {
  expect(run).toThrow(Rejection);
  expect(run).toThrow(Error(message));
}
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

it("refuses with a Rejection and the exact message", () => {
  const f = templateDeletionFixture();
  const preview = (uuids: string[]) => () =>
    templateDeletionPreview(f.s, uuids);
  const between = "Select between 1 and 100 distinct templates.";
  expectRefusal(preview([]), between);
  expectRefusal(preview([f.template.uuid, f.template.uuid]), between);
  const many = Array.from({ length: 101 }, () => crypto.randomUUID());
  expectRefusal(preview(many), between);
  const unavailable =
    "A selected template is unavailable in this Flight Program. Refresh the list.";
  expectRefusal(preview(many.slice(1)), unavailable);
  expectRefusal(preview([crypto.randomUUID()]), unavailable);
  f.s.taskCards!.push({
    ...f.task,
    uuid: crypto.randomUUID(),
    sourceKey: "task-csv:later-import",
  });
  const command = JSON.parse(
    JSON.stringify(templateDeletionPreview(f.s, [f.template.uuid])),
  );
  command.taskCards[1] = command.taskCards[0];
  expectRefusal(
    () => deleteInspectionTemplates(f.s, command),
    "Templates or associated job cards changed. Reopen the deletion preview before continuing.",
  );
  f.job.prerequisiteUuids = [f.task.uuid];
  expectRefusal(
    preview([f.template.uuid]),
    "Job card “Independent job card” depends on a card selected for deletion. Remove its prerequisite links before deleting these templates.",
  );
  f.job.prerequisiteUuids = [];
  f.s.user.isAdmin = false;
  f.s.user.groupIds = ["restricted-maintenance"];
  f.s.groups.push({
    id: "restricted-maintenance",
    name: "Restricted maintenance",
    programUuid: "demo-program",
    aircraftIds: [f.s.aircraft[1].uuid],
    permissions: ["read", "maintenance"],
  });
  expectRefusal(
    preview([f.template.uuid]),
    "Maintenance access to every aircraft with associated job cards is required. Ask a Flight Program administrator to delete these templates.",
  );
  f.s.user.groupIds = [];
  expectRefusal(
    preview([f.template.uuid]),
    "Maintenance permission is required to delete templates.",
  );
});
