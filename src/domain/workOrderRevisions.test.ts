/**
 * Responsibility: Pins revisions of closed work orders: the original is kept,
 *   compliance is not replayed, and refusals change nothing.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrders.ts, ./logbook, src/data/demo.ts,
 *   tests/fixtures/workOrders.ts.
 */
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
const NOW = Date.parse("2026-10-02T12:00:00Z");

/** A work order for the first demo inspection, opened and closed today. */
function setup() {
  const s = demoSnapshot();
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: s.inspections[0].uuid },
      s.inspections[0].description,
    ),
  ];
  const open = saveWorkOrder(s, command, NOW);
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
      },
    },
    NOW,
  );
  return { s, order };
}
/** A revise command with new release and work-performed text. */
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
      workPerformed: "Corrected work performed",
    },
  };
}
it("preserves the original, records multiple revisions and never replays closeout compliance", () => {
  const { s, order } = setup();
  const before = structuredClone(s);
  const revised = saveWorkOrder(s, revision(order), NOW + 1000);
  expect(revised.status).toBe("completed");
  expect(revised.closeout).toEqual(order.closeout);
  expect(revised.tasks).toEqual(order.tasks);
  expect(revised.revisions?.[0]).toMatchObject({
    number: 1,
    authorId: s.user.id,
    reason: "Corrected transcription",
    recordedAt: NOW + 1000,
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
  const second = saveWorkOrder(s, cmd, NOW + 2000);
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
    saveWorkOrder(s, { ...revision(order), reason: " " }, NOW),
  ).toThrow();
  expect(() =>
    saveWorkOrder(s, { ...revision(order), version: 0 }, NOW),
  ).toThrow("changed");
  expect(s).toEqual(before);
  const revised = saveWorkOrder(s, revision(order), NOW);
  expect(() => saveWorkOrder(s, revision(revised), NOW)).toThrow(
    "Change at least one",
  );
  s.user.isAdmin = false;
  s.user.groupIds = [];
  s.groups = [];
  expect(() => saveWorkOrder(s, revision(revised), NOW)).toThrow(
    "access denied",
  );
});
it("rejects revisions on open work orders", () => {
  const s = demoSnapshot();
  const order = saveWorkOrder(s, workOrderCommand(), NOW);
  expect(() => saveWorkOrder(s, revision(order), NOW)).toThrow("Only closed");
});

it("requires a release statement on a completed work order correction", () => {
  const { s, order } = setup();
  const command = revision(order);
  command.fields.releaseOutcome = "";
  expect(() => saveWorkOrder(s, command, NOW)).toThrow(
    "requires a release statement",
  );
  command.fields.releaseOutcome = "Corrected release";
  const revised = saveWorkOrder(s, command, NOW);
  expect(revised.releaseOutcome).toBe("Corrected release");
});
