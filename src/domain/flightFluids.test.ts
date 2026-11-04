/**
 * Responsibility: Pins fuel and oil reading checks, use and rate, and how a
 *   guided flight and its checklist link carry the readings.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightFluids.ts, ./guidedFlight, ./checklists,
 *   ./flightChecklistLink, ./model, src/data/demo.ts (seed).
 */
import { guidedDraftSchema, suggestedStartSection } from "./guidedFlight";
import { oilUseSincePreviousStart } from "./flightFluids";
import type { Flight } from "./model";
import { describe, it, expect } from "vitest";
import {
  fuelSchema,
  oilSchema,
  fluidUsed,
  fluidRate,
  oilLevelLabel,
} from "./flightFluids";
import { demoSnapshot } from "../data/demo";
import { emptyChecklist } from "./checklists";
import { guidedFlightLink, type GuidedDraft } from "./guidedFlight";
import {
  preserveChecklistLink,
  validateChecklistFlight,
} from "./flightChecklistLink";
import { flightInputSchema, type FlightInput } from "./model";
const now = new Date().toISOString();
const input: FlightInput = {
  aircraftUuid: "demo-206",
  pilotId: "demo-admin",
  startTime: now,
  hobbsOn: 2342.2 * 3600,
  cycles: 1,
  landings: 1,
  origin: "A",
  destination: "B",
  operation: "Private",
  flightRules: "VFR",
  remarks: "",
  discrepancy: "",
};
function draft(): GuidedDraft {
  const document = emptyChecklist();
  document.payload.groups[0].items = [
    {
      objectId: "g",
      title: "Normal",
      items: [
        {
          objectId: "l",
          title: "Preflight",
          items: [
            { objectId: "check", title: "Verify" },
            { objectId: "comment", type: "comment", title: "Note" },
            { objectId: "skip", title: "Skip" },
          ],
        },
      ],
    },
  ];
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: "demo-206",
    startedAt: now,
    opening: {
      version: 0,
      hobbs: 2341.2 * 3600,
      tach: Math.round(2261.2 * 3600),
    },
    checklist: {
      uuid: crypto.randomUUID(),
      version: 1,
      programUuid: "demo-program",
      aircraftUuid: "demo-206",
      sourceName: "test",
      updatedAt: 0,
      updatedBy: "demo-admin",
      document,
    },
    plan: {
      uuid: crypto.randomUUID(),
      version: 1,
      aircraftUuid: "demo-206",
      registration: "N206MA",
      departureAt: now,
      origin: "A",
      destination: "B",
      alternate: "",
      durationMinutes: 60,
      cycles: 1,
      landings: 1,
      flightRules: "V",
      aircraftType: "C206",
      flightType: "G",
      speed: "",
      level: "",
      route: "DCT",
      pilotText: "",
      equipment: "",
      otherInformation: "",
      sourceName: "",
      sourceHash: "a".repeat(64),
      status: "proposed",
      createdAt: 0,
    },
    preflightList: "l",
    shutdownList: "l",
    metersVerifiedAt: now,
    progress: { check: "checked", skip: "skipped", comment: "checked" },
    fuel: { unit: "US gal", start: 30, added: 10, end: 25 },
    oil: [{ engine: "single", unit: "US qt", start: 6, added: 1, end: 6.5 }],
  };
}
describe("flight fluid records", () => {
  it("keeps old entries valid and missing measurements unknown", () => {
    expect(flightInputSchema.parse(input).fuel).toBeUndefined();
    expect(fluidUsed({ start: 5, end: 3 })).toBeUndefined();
    expect(fluidUsed({ start: 5, added: 0, end: 3 })).toBe(2);
    expect(fluidRate({ start: 5, added: 0, end: 3 }, 0)).toBeUndefined();
  });
  it("calculates consumption and actual meter-hour rate", () => {
    expect(fluidUsed({ start: 30, added: 10, end: 25 })).toBe(15);
    expect(fluidRate({ start: 30, added: 10, end: 25 }, 7200)).toBe(7.5);
    expect(fluidUsed({ start: 0.1, added: 0.2, end: 0.3 })).toBe(0);
  });
  it("rejects negative, nonfinite, impossible balances and mixed engine identities", () => {
    expect(() => fuelSchema.parse({ unit: "L", start: -1 })).toThrow();
    expect(() => fuelSchema.parse({ unit: "L", start: Infinity })).toThrow();
    expect(() =>
      fuelSchema.parse({ unit: "L", start: 5, added: 1, end: 7 }),
    ).toThrow("Shutdown");
    expect(() =>
      oilSchema.parse([
        { engine: "single", unit: "L" },
        { engine: "left", unit: "L" },
      ]),
    ).toThrow();
  });
  it("requires physical verification and complete fluids for every engine", () => {
    const d = draft();
    expect(guidedFlightLink(d, false)).toMatchObject({
      checked: ["check"],
      skipped: ["skip"],
      totalChecks: 2,
    });
    expect(() =>
      guidedFlightLink({ ...d, metersVerifiedAt: undefined }, false),
    ).toThrow("Verify");
    expect(() =>
      guidedFlightLink(
        { ...d, fuel: { unit: "L", start: 20, end: 15 } },
        false,
      ),
    ).toThrow("starting level");
    expect(() => guidedFlightLink(d, true)).toThrow("each engine");
    expect(
      guidedFlightLink(
        {
          ...d,
          oil: [
            { engine: "left", unit: "L", start: 5, added: 0, end: 4 },
            { engine: "right", unit: "L", start: 5, added: 1, end: 5 },
          ],
        },
        true,
      ),
    ).toBeDefined();
  });
  it("enforces checklist aircraft/program scope and immutable run evidence during corrections", () => {
    const d = draft(),
      s = demoSnapshot();
    s.checklists = [d.checklist];
    const linked = { ...input, checklistRun: guidedFlightLink(d, false) };
    validateChecklistFlight(s, linked);
    expect(() =>
      validateChecklistFlight(s, { ...linked, aircraftUuid: "demo-208" }),
    ).toThrow("unavailable");
    expect(() =>
      preserveChecklistLink(linked, {
        ...linked,
        fuel: { unit: "L", start: 20, added: 0, end: 10 },
      }),
    ).not.toThrow();
    expect(() =>
      preserveChecklistLink(linked, { ...linked, checklistRun: undefined }),
    ).toThrow("cannot change");
  });
});

it("records range levels without treating them as oil volumes", () => {
  const reading = oilSchema.parse([
    {
      engine: "single",
      unit: "range",
      start: 25,
      added: 1,
      addedUnit: "US qt",
      end: 75,
    },
  ])[0];
  expect(fluidUsed(reading)).toBeUndefined();
  expect(fluidRate(reading, 3600)).toBeUndefined();
  expect(() => oilSchema.parse([{ ...reading, start: 20 }])).toThrow(
    "Choose an oil level",
  );
  expect(() => oilSchema.parse([{ ...reading, addedUnit: undefined }])).toThrow(
    "Select a unit",
  );
  const d = { ...draft(), oil: [reading] };
  expect(guidedFlightLink(d, false)).toBeDefined();
  expect(() =>
    guidedFlightLink({ ...d, oil: [{ ...reading, start: undefined }] }, false),
  ).toThrow("starting level");
});

it("uses successive preflight oil readings, ignoring legacy shutdown and current additions", () => {
  const previous: Flight = {
    ...input,
    uuid: "previous",
    authorId: "pilot",
    submittedAt: 0,
    status: "accepted",
    startTime: "2026-10-01T10:00:00Z",
    oil: [{ engine: "single", unit: "US qt", start: 6, added: 1, end: 2 }],
  };
  const current: Flight = {
    ...previous,
    uuid: "current",
    startTime: "2026-10-02T10:00:00Z",
    oil: [{ engine: "single", unit: "US qt", start: 6.5, added: 2 }],
  };
  expect(oilUseSincePreviousStart(current, previous, "single")).toBe(0.5);
  expect(
    oilUseSincePreviousStart(current, undefined, "single"),
  ).toBeUndefined();
  expect(
    oilUseSincePreviousStart(
      current,
      { ...previous, status: "review" },
      "single",
    ),
  ).toBeUndefined();
  expect(
    oilUseSincePreviousStart(
      current,
      { ...previous, oil: undefined },
      "single",
    ),
  ).toBeUndefined();
  expect(
    oilUseSincePreviousStart(
      current,
      {
        ...previous,
        oil: [{ engine: "single", unit: "L", start: 6, added: 1 }],
      },
      "single",
    ),
  ).toBeUndefined();
  expect(
    oilUseSincePreviousStart(
      {
        ...current,
        oil: [{ engine: "single", unit: "US qt", start: 8, added: 0 }],
      },
      previous,
      "single",
    ),
  ).toBeUndefined();
  expect(oilUseSincePreviousStart(current, previous, "left")).toBeUndefined();
  for (const unit of ["US qt", "range"] as const) {
    const d = {
      ...draft(),
      oil: [
        {
          engine: "single" as const,
          unit,
          start: unit === "range" ? 50 : 6,
          added: 0,
          addedUnit: "US qt" as const,
        },
      ],
    };
    expect(guidedFlightLink(d, false)).toBeDefined();
  }
});

it("keeps optional engine start readings in guided drafts and suggests the actual start section", () => {
  expect(
    suggestedStartSection([
      { objectId: "before", title: "BEFORE START" },
      { objectId: "start", title: "ENGINE START" },
      { objectId: "after", title: "AFTER START" },
    ]),
  ).toBe("start");
  const original = draft();
  expect(guidedDraftSchema.parse(original).startList).toBeUndefined();
  const updated = {
    ...original,
    startList: "l",
    engineStarts: [
      { engine: "left", durationSeconds: 30, maxEgtC: 680 },
      { engine: "right", durationSeconds: 35, maxEgtC: 690 },
    ],
  };
  expect(
    guidedDraftSchema.parse(JSON.parse(JSON.stringify(updated))).engineStarts,
  ).toEqual(updated.engineStarts);
});

describe("reading limits and labels", () => {
  it("accepts levels up to 1,000,000 and allows float slack in the balance", () => {
    expect(() => fuelSchema.parse({ unit: "L", start: 1000000 })).not.toThrow();
    expect(() => fuelSchema.parse({ unit: "L", start: 1000001 })).toThrow();
    expect(() =>
      fuelSchema.parse({ unit: "L", start: 0.3, added: 0, end: 0.3000005 }),
    ).not.toThrow();
    expect(fluidUsed({ start: 0.3, added: 0, end: 0.3000005 })).toBe(0);
    expect(fluidUsed({ start: 0.3, added: 0, end: 0.30001 })).toBeUndefined();
    expect(fluidUsed({ start: 1, added: 0, end: 0.1234564 })).toBe(0.876544);
    expect(
      fluidRate({ start: 5, added: 0, end: 3 }, undefined),
    ).toBeUndefined();
  });

  it("checks inventory oil and engines, but not the oil balance", () => {
    const reading = { engine: "single" as const, unit: "L" as const };
    const inventory = { locationUuid: "l", stockUuid: "s", quantity: 1 };
    expect(() =>
      oilSchema.parse([{ ...reading, inventory, added: 0 }]),
    ).toThrow("Enter a positive amount of oil added before using inventory.");
    expect(() =>
      oilSchema.parse([{ ...reading, start: 1, added: 0, end: 5 }]),
    ).not.toThrow();
    for (const oil of [
      [reading, reading],
      [
        { ...reading, engine: "left" },
        { ...reading, engine: "left" },
      ],
    ])
      expect(() => oilSchema.parse(oil)).toThrow(
        "Use a single engine or separate left/right engines.",
      );
    const left = { ...reading, engine: "left" };
    const right = { ...reading, engine: "right" };
    expect(() => oilSchema.parse([left, right, right])).toThrow(
      "expected array to have <=2 items",
    );
  });

  it("labels oil levels by band or volume", () => {
    const range = { engine: "single" as const, unit: "range" as const };
    expect(oilLevelLabel(range, undefined)).toBe("not recorded");
    expect(oilLevelLabel(range, 25)).toBe("25% above Add");
    expect(oilLevelLabel(range, 30)).toBe("Unknown");
    expect(oilLevelLabel({ ...range, unit: "L" }, 4.5)).toBe("4.5 L");
  });

  it("does not compare flights on different aircraft or out of start order", () => {
    const previous: Flight = {
      ...input,
      uuid: "previous",
      authorId: "pilot",
      submittedAt: 0,
      status: "accepted",
      startTime: "2026-10-01T10:00:00Z",
      oil: [{ engine: "single", unit: "US qt", start: 6, added: 1 }],
    };
    const current: Flight = {
      ...previous,
      uuid: "current",
      startTime: "2026-10-02T10:00:00Z",
      oil: [{ engine: "single", unit: "US qt", start: 6.5 }],
    };
    expect(oilUseSincePreviousStart(current, previous, "single")).toBe(0.5);
    expect(
      oilUseSincePreviousStart(
        { ...current, aircraftUuid: "demo-208" },
        previous,
        "single",
      ),
    ).toBeUndefined();
    expect(
      oilUseSincePreviousStart(
        { ...current, startTime: previous.startTime },
        previous,
        "single",
      ),
    ).toBeUndefined();
  });
});
