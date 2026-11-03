/**
 * Responsibility: Pins that older close-outs still parse and that readings
 *   and component work keep their shapes.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrderCloseoutSchema.ts.
 */
import { describe, expect, it } from "vitest";
import {
  closeoutSchema,
  completionReadingsSchema,
} from "./workOrderCloseoutSchema";

const readings = { totalSeconds: 7200, hobbs: 3600, tach: 3240, cycles: 4 };
const life = {
  timeSinceNew: 3600,
  timeSinceOverhaul: null,
  timeSinceRepair: null,
  cyclesSinceNew: 4,
  serviceDays: 30,
};
// The fields every close-out has had; later ones are optional.
const olderCloseout = () => ({
  recordedAt: 1_700_000_000_000,
  aircraft: {
    ...readings,
    registration: "N206MA",
    make: "Cessna",
    model: "206",
    serial: "1",
  },
  completedBy: {
    userId: "u",
    name: "Pat",
    licenseNumber: "A&P 1",
    certificateType: "Mechanic",
  },
  workPerformed: "Replaced tire.",
  components: [],
  compliance: [],
});
const work = (action: string) => ({
  componentUuid: "c",
  version: 1,
  action,
  description: "Overhauled and repaired.",
  reference: "CMM",
  date: "2026-11-03",
  before: life,
  after: { ...life, timeSinceOverhaul: 0, timeSinceRepair: 0 },
});

describe("closeoutSchema", () => {
  it("parses a close-out recorded before the optional fields existed", () => {
    expect(closeoutSchema.parse(olderCloseout())).toEqual(olderCloseout());
  });
  it("keeps the fields added since: performers and tracking baselines", () => {
    const current = {
      ...olderCloseout(),
      performers: [{ userId: "u", name: "Pat" }],
      componentWork: [
        {
          ...work("overhaul"),
          trackingBaseline: { before: "[]", after: "[]", movementUuids: ["m"] },
        },
      ],
    };
    expect(closeoutSchema.parse(current)).toEqual(current);
  });
  it("records component work, where both is a repair and an overhaul", () => {
    const closeout = { ...olderCloseout(), componentWork: [work("both")] };
    expect(closeoutSchema.parse(closeout).componentWork?.[0].action).toBe(
      "both",
    );
    expect(
      closeoutSchema.safeParse({ ...closeout, componentWork: [work("scrap")] })
        .success,
    ).toBe(false);
  });
});

describe("completionReadingsSchema", () => {
  it("takes whole, non-negative readings", () => {
    expect(completionReadingsSchema.parse(readings)).toEqual(readings);
    for (const hobbs of [-1, 0.5])
      expect(
        completionReadingsSchema.safeParse({ ...readings, hobbs }).success,
      ).toBe(false);
  });
});
