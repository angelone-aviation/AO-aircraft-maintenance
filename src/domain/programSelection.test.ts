/**
 * Responsibility: Pins switching the active Flight Program: who may, what
 *   changes, and the change-log row both adapters write.
 * Layer: Test. Vitest suite on the demo seed; never shipped in the build.
 * Dependencies: ./programSelection, ./rejection, src/data/demo.ts.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { selectProgram } from "./programSelection";
import { Rejection } from "./rejection";

it("activates a program the user may read, and logs it under that program", () => {
  const s = demoSnapshot();
  const entry = selectProgram(s, "demo-program");
  expect(s.user.activeProgramUuid).toBe("demo-program");
  expect(entry).toMatchObject({
    action: "program.selected",
    entityUuid: "demo-program",
    programUuid: "demo-program",
    actorId: s.user.id,
  });
});

it("lets a system administrator open the unassigned records, logged under none", () => {
  const s = demoSnapshot();
  const entry = selectProgram(s, "");
  expect(s.user.activeProgramUuid).toBe("");
  expect(entry).toMatchObject({ entityUuid: "unassigned" });
  expect(entry.programUuid).toBeUndefined();
});

it("refuses an unknown program, or the unassigned records to anyone else, changing nothing", () => {
  const s = demoSnapshot();
  const before = s.user.activeProgramUuid;
  expect(() => selectProgram(s, "unknown")).toThrow(
    new Rejection("Flight Program access denied."),
  );
  s.user = { ...s.user, isAdmin: false };
  expect(() => selectProgram(s, "")).toThrow(Rejection);
  expect(s.user.activeProgramUuid).toBe(before);
});
