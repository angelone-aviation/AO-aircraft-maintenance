/**
 * Responsibility: Pins the job card form's save and signing warnings and the
 *   messages it builds from a refused save.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/taskCardValidation.ts, taskCards.ts;
 *   src/data/demo.ts and tests/fixtures/taskCards.ts (fixtures).
 */
import { expect, it } from "vitest";
import { ZodError } from "zod";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { saveTaskCard, taskCardFieldsSchema } from "./taskCards";
import {
  taskCardSaveWarnings,
  taskCardSigningWarnings,
  taskCardValidationMessages,
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

it("names each refused field, inside its step or part, and falls back for other errors", () => {
  const error = new ZodError([
    {
      code: "too_small",
      origin: "string",
      minimum: 1,
      inclusive: true,
      path: ["partsUsed", 1, "partNumber"],
      message: "Too small",
    },
    {
      code: "too_small",
      origin: "number",
      minimum: 1,
      inclusive: true,
      path: ["partsUsed", 1, "quantity"],
      message: "Too small",
    },
    { code: "custom", path: ["maintenanceReference"], message: "Too long" },
  ]);
  expect(taskCardValidationMessages(error)).toEqual([
    "Part 2: Part number is required.",
    "Part 2: Quantity: Too small",
    "maintenance Reference: Too long",
  ]);
  expect(taskCardValidationMessages(Error("First\nSecond"))).toEqual([
    "First",
    "Second",
  ]);
  expect(taskCardValidationMessages("down")).toEqual([
    "Unable to save the job card.",
  ]);
});

it("lists every reason a job card cannot be signed yet, in order", () => {
  const fields = { ...taskCardCommand().fields, status: "draft" as const };
  const stored = saveTaskCard(demoSnapshot(), taskCardCommand(), now);
  expect(
    taskCardSigningWarnings({ ...fields, completionDate: "9999-12-31" }, true),
  ).toEqual([
    "Completion date cannot be in the future.",
    "Change Task status to Ready or In progress and save before signing.",
    "Save the job card before signing.",
  ]);
  expect(taskCardSigningWarnings(fields, true, stored)).toEqual([
    "Change Task status to Ready or In progress and save before signing.",
    "Save your changes before signing. Changes clear existing signoffs.",
  ]);
  expect(
    taskCardSigningWarnings({ ...fields, status: "ready" }, false, stored),
  ).toEqual([]);
});
