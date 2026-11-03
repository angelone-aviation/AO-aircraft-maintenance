import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { saveTaskCard, type TaskCardCommand } from "./taskCards";

function fixture() {
  const state = demoSnapshot();
  const command = taskCardCommand();
  command.fields.inspectionUuid = state.inspections[0].uuid;
  const card = saveTaskCard(state, command);
  const unlink: TaskCardCommand = {
    action: "unlink",
    uuid: card.uuid,
    version: card.version,
    link: { kind: "inspection", uuid: command.fields.inspectionUuid },
  };
  return { state, card, unlink };
}

it("unlinks a template without deleting it or changing existing copies, and permits relinking", () => {
  const { state, card, unlink } = fixture();
  const copy = {
    ...structuredClone(card),
    uuid: crypto.randomUUID(),
    sourceTaskCardUuid: card.uuid,
    cardNumber: "COPY-1",
    workOrderUuid: crypto.randomUUID(),
  };
  state.taskCards!.push(copy);
  const before = structuredClone(copy);
  const removed = saveTaskCard(state, unlink);
  expect(removed.inspectionUuid).toBe("");
  expect(removed.description).toBe(card.description);
  expect(removed.version).toBe(card.version + 1);
  expect(state.taskCards).toHaveLength(2);
  expect(state.taskCards!.find((item) => item.uuid === copy.uuid)).toEqual(
    before,
  );
  const relinked = saveTaskCard(state, {
    ...unlink,
    action: "link",
    version: removed.version,
  });
  expect(relinked.inspectionUuid).toBe(card.inspectionUuid);
});

it("rejects stale requests and mismatched links without changing records", () => {
  const { state, unlink } = fixture();
  const before = structuredClone(state.taskCards);
  expect(() => saveTaskCard(state, { ...unlink, version: 0 })).toThrow(
    "changed",
  );
  expect(() =>
    saveTaskCard(state, {
      ...unlink,
      link: { kind: "inspection", uuid: "another-item" },
    }),
  ).toThrow("Only unsigned");
  expect(state.taskCards).toEqual(before);
});

it.each(["recorded", "signed", "copy", "completed"] as const)(
  "rejects removal of %s work",
  (kind) => {
    const { state, card, unlink } = fixture();
    if (kind === "recorded") card.actualWork = "Work performed";
    if (kind === "signed")
      card.technicianSignoff = {
        userId: state.user.id,
        name: state.user.name,
        at: Date.now(),
      };
    if (kind === "copy") card.sourceTaskCardUuid = crypto.randomUUID();
    if (kind === "completed") card.status = "completed";
    const before = structuredClone(state.taskCards);
    expect(() => saveTaskCard(state, unlink)).toThrow();
    expect(state.taskCards).toEqual(before);
  },
);
