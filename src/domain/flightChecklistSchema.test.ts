/**
 * Responsibility: Pins the meter and progress rules of a checklist run stored
 *   on a flight.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightChecklistSchema.ts.
 */
import { describe, expect, it } from "vitest";
import { checklistFlightSchema } from "./flightChecklistSchema";

const run = () => ({
  sessionUuid: "8b0f6c1e-1d2a-4a5b-9c3d-2e4f6a8b0c1d",
  checklistUuid: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  checklistVersion: 1,
  checklistName: "Preflight",
  startedAt: "2026-11-03T12:00:00Z",
  metersVerifiedAt: "2026-11-03T12:05:00Z",
  preflight: { hobbs: 3600, tach: 0 },
  checked: ["a", "b"],
  skipped: ["c"],
  totalChecks: 3,
});
const messages = (value: unknown) =>
  checklistFlightSchema.safeParse(value).error?.issues.map((i) => i.message);

describe("checklistFlightSchema", () => {
  it("accepts a run whose items fill the checklist", () => {
    expect(checklistFlightSchema.parse(run())).toEqual(run());
  });
  it("takes meter readings in whole tenths of an hour, in seconds", () => {
    expect(
      checklistFlightSchema.safeParse({
        ...run(),
        preflight: { hobbs: 360, tach: 720, cyclic: 0, flightTimeLog: 1080 },
      }).success,
    ).toBe(true);
    for (const tach of [180, 361])
      expect(messages({ ...run(), preflight: { hobbs: 3600, tach } })).toEqual([
        "Use meter readings in tenths of an hour.",
      ]);
  });
  it("refuses an item listed twice or more items than the checklist has", () => {
    const invalid = ["Invalid checklist progress totals."];
    expect(messages({ ...run(), skipped: ["a"] })).toEqual(invalid);
    expect(messages({ ...run(), checked: ["a", "a"], skipped: [] })).toEqual(
      invalid,
    );
    expect(messages({ ...run(), totalChecks: 2 })).toEqual(invalid);
  });
  it("caps the checklist at 10,000 items", () => {
    expect(
      checklistFlightSchema.safeParse({ ...run(), totalChecks: 10000 }).success,
    ).toBe(true);
    expect(
      checklistFlightSchema.safeParse({ ...run(), totalChecks: 10001 }).success,
    ).toBe(false);
  });
});
