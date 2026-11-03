import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { saveTaskCard, taskCardFieldsSchema } from "./taskCards";
import {
  taskCardSaveWarnings,
  taskCardSigningWarnings,
} from "./taskCardValidation";
const now = Date.parse("2026-10-01T12:00:00Z");
it("allows saving, signing and completing without actual work text", () => {
  const s = demoSnapshot(),
    cmd = taskCardCommand();
  let t = saveTaskCard(s, cmd, now);
  t = saveTaskCard(
    s,
    {
      ...cmd,
      version: t.version,
      fields: {
        ...taskCardFieldsSchema.parse(t),
        status: "in-progress",
        actualWork: "",
        completionDate: "2026-10-01",
        steps: [],
      },
    },
    now,
  );
  t = saveTaskCard(
    s,
    { action: "sign", uuid: t.uuid, version: t.version, kind: "technician" },
    now,
  );
  const completed = saveTaskCard(
    s,
    {
      ...cmd,
      version: t.version,
      fields: { ...taskCardFieldsSchema.parse(t), status: "completed" },
    },
    now,
  );
  expect(completed.status).toBe("completed");
  expect(completed.actualWork).toBe("");
});
it("permits a blank date in the form while the backend requires a date before signing", () => {
  const s = demoSnapshot(),
    cmd = taskCardCommand();
  let t = saveTaskCard(s, cmd, now);
  t = saveTaskCard(
    s,
    {
      ...cmd,
      version: t.version,
      fields: { ...taskCardFieldsSchema.parse(t), status: "in-progress" },
    },
    now,
  );
  expect(
    taskCardSaveWarnings(s, t.uuid, taskCardFieldsSchema.parse(t), t),
  ).toEqual([]);
  expect(
    taskCardSigningWarnings(taskCardFieldsSchema.parse(t), false, t),
  ).toEqual([]);
  expect(() =>
    saveTaskCard(
      s,
      { action: "sign", uuid: t.uuid, version: t.version, kind: "technician" },
      now,
    ),
  ).toThrow("completion date");
});
it("lists missing save fields and all completion blockers without changing stored records", () => {
  const s = demoSnapshot(),
    cmd = taskCardCommand();
  const snapshot = structuredClone(s);
  const fields = {
    ...cmd.fields,
    title: "",
    steps: cmd.fields.steps.map((step) => ({ ...step, instruction: "" })),
  };
  expect(taskCardSaveWarnings(s, cmd.uuid, fields)).toEqual([
    "Title is required.",
    "Step 1: Instruction is required.",
  ]);
  expect(s).toEqual(snapshot);
  const card = saveTaskCard(s, cmd, now);
  const warnings = taskCardSaveWarnings(
    s,
    card.uuid,
    {
      ...taskCardFieldsSchema.parse(card),
      status: "completed",
      inspectionSignoffRequired: true,
    },
    card,
  ).join(" ");
  expect(warnings).toContain("completion date");
  expect(warnings).toContain("technician signoff");
  expect(warnings).toContain("inspection signoff");
});
