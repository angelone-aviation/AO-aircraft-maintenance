/**
 * Responsibility: Pins an AD's compliance history as corrected.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/adCompliance.ts, airworthiness.ts.
 */
import { expect, it } from "vitest";
import { effectiveCompliance, lastCompliance } from "./adCompliance";
import { blankAD, type ADCompliance } from "./airworthiness";

const entry = (
  uuid: string,
  taskUuid: string,
  corrects?: string,
): ADCompliance => ({
  uuid,
  taskUuid,
  corrects,
  date: "2026-11-01",
  hours: 100,
  cycles: 10,
  method: "Inspected",
  serviceBulletin: "",
  terminatedBy: "",
  workOrderUuid: "",
  mechanic: "",
  certificate: "",
  evidence: "",
  recordedAt: 0,
  recordedBy: "",
});

it("shows each entry's latest correction in its place and finds the last per required action", () => {
  const r = {
    ...blankAD("demo-206"),
    history: [
      entry("first", "inspect"),
      entry("part", "replace"),
      entry("first-fix", "inspect", "first"),
      entry("second", "inspect"),
      entry("first-fix-2", "inspect", "first"),
    ],
  };
  expect(effectiveCompliance(r).map((h) => h.uuid)).toEqual([
    "first-fix-2",
    "part",
    "second",
  ]);
  expect(lastCompliance(r, "inspect")?.uuid).toBe("second");
  expect(lastCompliance(r, "replace")?.uuid).toBe("part");
  expect(lastCompliance(r, "none")).toBeUndefined();
});
