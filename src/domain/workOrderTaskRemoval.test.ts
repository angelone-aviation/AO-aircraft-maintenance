import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { saveTaskCard, taskCardFieldsSchema, taskWritable } from "./taskCards";
import { scopedSnapshot } from "./programs";
import {
  newWorkTask,
  saveWorkOrder,
  workOrderFieldsSchema,
} from "./workOrders";

const now = Date.parse("2026-10-01T12:00:00Z");
function fixture() {
  const state = demoSnapshot();
  const source = {
    kind: "inspection" as const,
    uuid: state.inspections[0].uuid,
  };
  const templateCommand = taskCardCommand();
  templateCommand.fields.inspectionUuid = source.uuid;
  const template = saveTaskCard(state, templateCommand, now);
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask(source, "Inspection"),
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, "Keep me"),
  ];
  const order = saveWorkOrder(state, command, now);
  const copy = state.taskCards!.find(
    (card) => card.workOrderUuid === order.uuid,
  )!;
  const remove = {
    ...command,
    version: order.version,
    fields: workOrderFieldsSchema.parse(order),
    tasks: order.tasks.slice(1),
  };
  return { state, template, order, copy, remove };
}

it("removes selected tasks and unused copies while retaining templates and an audit record", () => {
  const { state, template, copy, remove } = fixture();
  const next = saveWorkOrder(state, remove, now);
  expect(next.tasks.map((task) => task.description)).toEqual(["Keep me"]);
  expect(state.taskCards!.some((card) => card.uuid === copy.uuid)).toBe(false);
  expect(state.taskCards!.find((card) => card.uuid === template.uuid)).toEqual(
    template,
  );
  expect(
    state.audit.some(
      (entry) =>
        entry.action === "taskCard.archived_with_task" &&
        JSON.parse(entry.before!).uuid === copy.uuid,
    ),
  ).toBe(true);
});

it.each(["signed", "work", "evidence", "task-notes", "completed"] as const)(
  "archives %s without signer approval and preserves its recorded data",
  (kind) => {
    const { state, order, copy, remove } = fixture();
    if (kind === "signed")
      copy.technicianSignoff = {
        userId: state.user.id,
        name: state.user.name,
        at: now,
      };
    if (kind === "work") copy.actualWork = "Work performed";
    if (kind === "evidence")
      state.taskEvidence = [
        {
          uuid: crypto.randomUUID(),
          taskCardUuid: copy.uuid,
          name: "photo",
          size: 1,
          uploadedAt: now,
          url: "",
          category: "photo",
        },
      ];
    if (kind === "task-notes") order.tasks[0].notes = "Recorded work";
    if (kind === "completed") order.tasks[0].status = "completed";
    const cardBefore = structuredClone(copy);
    const taskBefore = structuredClone(order.tasks[0]);
    const evidenceBefore = structuredClone(state.taskEvidence);
    const next = saveWorkOrder(state, remove, now);
    expect(
      state.archivedTaskCards!.find((card) => card.uuid === copy.uuid),
    ).toEqual(cardBefore);
    expect(next.archivedTasks![0].task).toEqual(taskBefore);
    expect(next.archivedTasks![0]).toMatchObject({
      removedAt: now,
      removedBy: state.user.id,
      cardUuids: [copy.uuid],
    });
    expect(state.taskEvidence).toEqual(evidenceBefore);
    expect(taskWritable(state, copy)).toBe(false);
    expect(() =>
      saveTaskCard(state, {
        action: "save",
        uuid: copy.uuid,
        version: 0,
        fields: taskCardFieldsSchema.parse(copy),
      }),
    ).toThrow("read-only");
    expect(
      scopedSnapshot(state).archivedTaskCards!.some(
        (card) => card.uuid === copy.uuid,
      ),
    ).toBe(true);
    const otherProgram = {
      ...state,
      archivedTaskCards: [{ ...copy, aircraftUuid: "inaccessible" }],
    };
    expect(scopedSnapshot(otherProgram).archivedTaskCards).toEqual([]);
  },
);

it("rejects a stale removal and prevents removal on a closed order", () => {
  const { state, order, remove } = fixture();
  expect(() => saveWorkOrder(state, { ...remove, version: 0 }, now)).toThrow(
    "changed",
  );
  order.status = "completed";
  expect(() => saveWorkOrder(state, remove, now)).toThrow("closed");
});

it("retains archived tasks and cards on later saves", () => {
  const { state, copy, remove } = fixture();
  const first = saveWorkOrder(state, remove, now);
  const second = saveWorkOrder(
    state,
    { ...remove, version: first.version, tasks: first.tasks },
    now + 1,
  );
  expect(second.archivedTasks).toEqual(first.archivedTasks);
  expect(state.archivedTaskCards).toHaveLength(1);
  expect(state.archivedTaskCards![0].uuid).toBe(copy.uuid);
});

it("keeps prerequisite-linked cards active until their dependency is removed", () => {
  const { state, order, copy, remove } = fixture();
  state.taskCards!.push({
    ...structuredClone(copy),
    uuid: crypto.randomUUID(),
    workTaskUuid: order.tasks[1].uuid,
    inspectionUuid: "",
    prerequisiteUuids: [copy.uuid],
  });
  const before = structuredClone(state);
  expect(() => saveWorkOrder(state, remove, now)).toThrow("prerequisite");
  expect(state).toEqual(before);
});
