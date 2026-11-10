/**
 * Responsibility: Pins, for every inspection limit, that "Keep mine" treats a
 *   due value under a repeat interval as derived (never a difference) and a
 *   due value without one as the other person's change.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/recordMerge.ts, keepMineRules.ts, model.ts.
 */
import { describe, expect, it } from "vitest";
import { mergeKeepMine } from "./recordMerge";
import { INSPECTION_KEEP_MINE } from "./keepMineRules";
import type { Inspection } from "./model";

const inspection: Inspection = {
  uuid: "i1",
  version: 1,
  aircraftUuid: "a1",
  reference: "Phase 1",
  description: "Airframe",
};

// Each limit's due field, its repeat interval, and the due value before and
// after the other person's completion.
const LIMITS = [
  ["dueSeconds", "intervalSeconds", 8_640_000, 8_784_000],
  ["dueCycles", "intervalCycles", 1_900, 2_000],
  ["dueLandings", "intervalLandings", 3_000, 3_100],
  ["dueDate", "intervalMonths", "2027-01-01", "2027-02-01"],
] as const;

describe.each(LIMITS)("%s", (due, interval, before, after) => {
  it(`is derived under ${interval}, so only the description differs`, () => {
    const stored = { ...inspection, [interval]: 1, [due]: before };
    const merge = mergeKeepMine(
      {
        base: stored,
        mine: { ...stored, description: "Engine", [due]: undefined },
        theirs: { ...stored, version: 2, [due]: after },
      },
      { rules: INSPECTION_KEEP_MINE },
    );
    expect(merge.fields.map((f) => f.key)).toEqual(["description"]);
    expect(merge.merged?.[due]).toBeUndefined();
  });

  it("is the other person's change without an interval, and kept", () => {
    const stored = { ...inspection, [due]: before };
    const merge = mergeKeepMine(
      {
        base: stored,
        mine: { ...stored, description: "Engine" },
        theirs: { ...stored, version: 2, [due]: after },
      },
      { rules: INSPECTION_KEEP_MINE },
    );
    expect(merge.fields.map((f) => [f.key, f.changedBy])).toEqual([
      ["description", "you"],
      [due, "them"],
    ]);
    expect(merge.merged?.[due]).toBe(after);
  });
});
