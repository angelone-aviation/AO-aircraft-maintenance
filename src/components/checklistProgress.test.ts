/**
 * Responsibility: Pins the checklist set totals and their ring slices.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/checklistProgress.ts,
 *   src/domain/checklists.ts (types).
 */
import { describe, expect, it } from "vitest";
import type { ChecklistDocument } from "../domain/checklists";
import { setTotals, totalsSlices, type SetTotals } from "./checklistProgress";

function set(): ChecklistDocument {
  const list = (objectId: string, ids: string[]) => ({
    objectId,
    title: objectId,
    items: [
      { objectId: `${objectId}-note`, type: "comment", title: "Note" },
      ...ids.map((id) => ({ objectId: id, title: id })),
    ],
  });
  const category = (groupType: string, lists: unknown[]) => ({
    objectId: groupType,
    groupType,
    items: [{ objectId: `${groupType}-group`, title: "", items: lists }],
  });
  return {
    payload: {
      metadata: { name: "Set" },
      groups: [
        category("normal", [list("l1", ["a", "b"]), list("l2", ["c"])]),
        category("emergency", [list("l3", ["d", "e"])]),
      ],
    },
  } as ChecklistDocument;
}

const totals = (fields: Partial<SetTotals>): SetTotals => ({
  checked: 0,
  skipped: 0,
  open: 0,
  total: 0,
  ...fields,
});

describe("setTotals", () => {
  it("counts checks in every category and list, leaving comments out", () => {
    expect(setTotals(set(), {})).toEqual({
      checked: 0,
      skipped: 0,
      open: 5,
      total: 5,
    });
  });

  it("splits checks by mark and ignores marks the set does not hold", () => {
    const progress = {
      a: "checked",
      d: "checked",
      c: "skipped",
      "l1-note": "checked",
      gone: "checked",
    } as const;
    expect(setTotals(set(), progress)).toEqual({
      checked: 2,
      skipped: 1,
      open: 2,
      total: 5,
    });
  });
});

describe("totalsSlices", () => {
  it("lists checked, skipped and not checked in that order", () => {
    expect(totalsSlices(totals({ checked: 2, skipped: 1, open: 3 }))).toEqual([
      { label: "Checked", value: 2, tone: "good" },
      { label: "Skipped", value: 1, tone: "warn" },
      { label: "Not checked", value: 3, tone: "5" },
    ]);
  });
});
