import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import {
  newWorkTask,
  saveWorkOrder,
  workOrderFieldsSchema,
  workOrderSchema,
  type WorkOrder,
  type WorkOrderCommand,
} from "./workOrders";
import { logbookText } from "./logbook";
const now = Date.parse("2026-10-02T12:00:00Z");
function setup() {
  const s = demoSnapshot();
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: s.inspections[0].uuid },
      s.inspections[0].description,
    ),
  ];
  const open = saveWorkOrder(s, command, now);
  const order = saveWorkOrder(
    s,
    {
      ...command,
      version: open.version,
      tasks: open.tasks.map((t) => ({ ...t, status: "completed" })),
      fields: {
        ...workOrderFieldsSchema.parse(open),
        status: "completed",
        completionDate: "2026-10-02",
        releaseOutcome: "Original release",
        finalReview: "Original review",
      },
    },
    now,
  );
  return { s, order };
}
function revision(
  order: WorkOrder,
): Extract<WorkOrderCommand, { action: "revise" }> {
  return {
    action: "revise",
    uuid: order.uuid,
    version: order.version,
    reason: "Corrected transcription",
    fields: {
      supervisor: order.supervisor,
      scope: order.scope,
      releaseOutcome: "Corrected release",
      finalReview: "Corrected review",
      workPerformed: "Corrected work performed",
    },
  };
}
it("preserves the original, records multiple revisions and never replays closeout compliance", () => {
  const { s, order } = setup();
  const before = structuredClone(s);
  const revised = saveWorkOrder(s, revision(order), now + 1000);
  expect(revised.status).toBe("completed");
  expect(revised.closeout).toEqual(order.closeout);
  expect(revised.tasks).toEqual(order.tasks);
  expect(revised.revisions?.[0]).toMatchObject({
    number: 1,
    authorId: s.user.id,
    reason: "Corrected transcription",
    recordedAt: now + 1000,
  });
  expect(
    workOrderSchema.parse(JSON.parse(revised.revisions![0].previousRecord)),
  ).toEqual(order);
  expect(s.inspections).toEqual(before.inspections);
  expect(s.management).toEqual(before.management);
  expect(s.taskCards).toEqual(before.taskCards);
  const text = logbookText(s, revised, "maintenance", {
    name: "Tech",
    licenseNumber: "123",
    certificateType: "A&P",
  });
  expect(text).toContain("Revision 1");
  expect(text).toContain("Corrected work performed");
  expect(text).toContain("Corrected release");
  const cmd = revision(revised);
  cmd.fields.scope = "Corrected scope";
  const second = saveWorkOrder(s, cmd, now + 2000);
  expect(second.revisions).toHaveLength(2);
  expect(second.revisions![0]).toEqual(revised.revisions![0]);
  expect(
    JSON.parse(second.revisions![1].previousRecord).revisedWorkPerformed,
  ).toBe("Corrected work performed");
  expect(
    JSON.parse(second.revisions![1].previousRecord).revisions,
  ).toBeUndefined();
});
it("rejects missing reasons, unchanged revisions, stale writes and unauthorized corrections atomically", () => {
  const { s, order } = setup();
  const before = structuredClone(s);
  expect(() =>
    saveWorkOrder(s, { ...revision(order), reason: " " }, now),
  ).toThrow();
  expect(() =>
    saveWorkOrder(s, { ...revision(order), version: 0 }, now),
  ).toThrow("changed");
  expect(s).toEqual(before);
  const revised = saveWorkOrder(s, revision(order), now);
  expect(() => saveWorkOrder(s, revision(revised), now)).toThrow(
    "Change at least one",
  );
  s.user.isAdmin = false;
  s.user.groupIds = [];
  s.groups = [];
  expect(() => saveWorkOrder(s, revision(revised), now)).toThrow(
    "access denied",
  );
});
it("rejects revisions on open work orders", () => {
  const s = demoSnapshot();
  const order = saveWorkOrder(s, workOrderCommand(), now);
  expect(() => saveWorkOrder(s, revision(order), now)).toThrow("Only closed");
});

it("allows completed work order corrections without a final review but still requires a release statement", () => {
  const { s, order } = setup();
  const command = revision(order);
  command.fields.finalReview = "";
  command.fields.releaseOutcome = "";
  expect(() => saveWorkOrder(s, command, now)).toThrow("requires a release statement");
  command.fields.releaseOutcome = "Corrected release";
  const revised = saveWorkOrder(s, command, now);
  expect(revised.finalReview).toBe("");
  expect(JSON.parse(revised.revisions![0].previousRecord).finalReview).toBe("Original review");
});
