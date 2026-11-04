/**
 * Responsibility: Pins the suggestions read from manual pages (phases,
 *   numbered entries, intervals and warnings) and manual applicability.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/manualDiscovery.ts, management.ts, components.ts
 *   and manuals.ts (types), src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import {
  discoverPage,
  manualApplicability,
  suggestedIntervals,
  matchesAircraft,
  matchesComponent,
} from "./manualDiscovery";
import type { Manual } from "./manuals";
import { demoSnapshot } from "../data/demo";
import { applyManagement } from "./management";
import type { Component } from "./components";
const manualUuid = "8ca8d890-1bd9-4c34-af64-1e277ccf41ac";
it("extracts the phase package, keeps its checklist text and identifies its source page", () => {
  const [row] = discoverPage(
    manualUuid,
    79,
    `CESSNA AIRCRAFT COMPANY
INSPECTION PHASE 2
1. Description
A. Phase 2 consists of 100-hour or 12 calendar months, whichever occurs first, interval inspection items.
B. Inspection items are listed in order of the zone.
2. General Inspection Criteria
A243003 Batteries - Inspect overboard vents and vent lines for
damage and obstructions.
5-12-02 Page 1`,
  );
  expect(row).toMatchObject({
    name: "Phase 2 inspection",
    kind: "inspection",
    hours: 100,
    months: 12,
    reference: {
      manualUuid,
      pdfPage: 79,
      section: "5-12-02",
      printedPage: "1",
    },
  });
  expect(row.text).toContain("damage and obstructions");
  expect(row.sourceKey).toBe(
    discoverPage(manualUuid, 79, row.text)[0].sourceKey,
  );
});
it("does not flatten initial, ambiguous, range, manufacture-age or overhaul-triggered rules", () => {
  for (const text of [
    "Phase 8 consists of items inspected at 1900 hours and every 600 hours thereafter.",
    "Replace every 3 years. Combination shelf life and service life shall not exceed 5 years.",
    "Replace 10 years from date of manufacture.",
    "Inspect every 100-200 hours.",
    "Replace every 5 years or engine overhaul.",
  ]) {
    const result = suggestedIntervals(text);
    expect(result.hours).toBeUndefined();
    expect(result.months).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  }
});
it("finds life-limit rows without an inspection verb and retains part applicability and notes", () => {
  const rows = discoverPage(
    manualUuid,
    62,
    `COMPONENT TIME LIMITS
1. Overhaul or Replacement Schedule
(1) Rudder Trim Tab Actuator - Overhaul or Replace Every 1000 Hours or 3 Years
(2) Cylinder (Part Number 176122-
115) - 24 Years or 4380 Cycles
(3) Fire Extinguisher Cartridge - Replace every 3 Years
NOTE: Shelf life and service life shall not exceed 5 years.
5-11-00 Page 1`,
  );
  expect(rows.find((r) => r.name.includes("Cylinder"))).toMatchObject({
    kind: "component",
    months: 288,
    cycles: 4380,
  });
  const cartridge = rows.find((r) => r.name.includes("Cartridge"))!;
  expect(cartridge.months).toBeUndefined();
  expect(cartridge.text).toContain("Shelf life");
});
it("matches model and manufacturer, with optional component part-number restriction", () => {
  const a = demoSnapshot().aircraft[0];
  expect(
    matchesAircraft(a, {
      kind: "aircraft",
      manufacturer: "cessna",
      model: " 206 Stationair ",
      partNumber: "",
    }),
  ).toBe(true);
  expect(
    matchesAircraft(a, {
      kind: "aircraft",
      manufacturer: "",
      model: "441",
      partNumber: "",
    }),
  ).toBe(false);
  const c = {
    model: "ABC",
    manufacturer: "Maker",
    partNumber: "P1",
  } as Component;
  expect(
    matchesComponent(c, {
      kind: "component",
      manufacturer: "maker",
      model: "abc",
      partNumber: "P1",
    }),
  ).toBe(true);
  expect(
    matchesComponent(c, {
      kind: "component",
      manufacturer: "maker",
      model: "abc",
      partNumber: "P2",
    }),
  ).toBe(false);
});
it("requires compliance, persists provenance, and rejects repeat imports for the same aircraft", () => {
  const s = demoSnapshot();
  s.manuals = [
    {
      uuid: manualUuid,
      aircraftUuid: s.aircraft[0].uuid,
      title: "Test",
      documentNumber: "",
      revision: "1",
      revisionDate: "",
      filename: "test.pdf",
      size: 100,
      pageCount: 100,
      uploadedAt: 0,
      uploadedBy: s.user.id,
    },
  ];
  const record = {
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid: s.aircraft[0].uuid,
    reference: "Phase 2",
    description: "Review completed",
    materials: "",
    archived: false,
    sourceKey: `${manualUuid}:79:phase-2`,
    manualReference: {
      manualUuid,
      pdfPage: 79,
      section: "5-12-02",
      printedPage: "1",
    },
    intervalSeconds: 360000,
    intervalMonths: 12,
  };
  const save = (
    r: typeof record & { lastSeconds?: number; lastDate?: string },
  ) =>
    applyManagement(s, {
      action: "inspection.save",
      requestUuid: crypto.randomUUID(),
      reason: "Reviewed manual",
      record: r,
    });
  expect(() => save(record)).toThrow("last compliance");
  save({ ...record, lastSeconds: 2000 * 3600, lastDate: "2025-01-12" });
  const created = s.inspections.find((i) => i.uuid === record.uuid)!;
  expect(created).toMatchObject({
    sourceKey: record.sourceKey,
    dueSeconds: 2100 * 3600,
    dueDate: "2026-01-31",
  });
  expect(() =>
    save({
      ...record,
      uuid: crypto.randomUUID(),
      lastSeconds: 2000 * 3600,
      lastDate: "2025-01-12",
    }),
  ).toThrow("already been added");
});

describe("manual applicability", () => {
  it("prefers the manual's own, else the model of its aircraft", () => {
    const a = demoSnapshot().aircraft[0];
    const own = {
      kind: "component" as const,
      manufacturer: "",
      model: "PT6A",
      partNumber: "",
    };
    const manual = { applicability: own } as Manual;
    expect(manualApplicability(manual, a)).toBe(own);
    expect(manualApplicability({} as Manual, a)).toEqual({
      kind: "aircraft",
      model: a.model,
      manufacturer: a.make,
      partNumber: "",
    });
    expect(manualApplicability({} as Manual, { ...a, model: "" })).toBe(
      undefined,
    );
    expect(
      matchesAircraft(
        { ...a, model: "206  Stationair" },
        {
          ...own,
          kind: "aircraft",
          model: "206 STATIONAIR",
        },
      ),
    ).toBe(true);
  });
});

describe("suggested intervals", () => {
  it("warns in order and prefills nothing that is day-based, repeated or zero", () => {
    expect(suggestedIntervals("Inspect every 30 days or 2 years")).toEqual({
      hours: undefined,
      cycles: undefined,
      months: 24,
      warnings: ["Day-based rule: enter the appropriate schedule manually."],
    });
    expect(
      suggestedIntervals(
        "Refer to service bulletin: 100 hours or 200 hours, 1-2 years",
      ).warnings,
    ).toEqual([
      "A range of limits was found; select the applicable value manually.",
      "Includes a reference to another section or publication.",
      "Multiple limits found for the same unit; intervals were not prefilled.",
    ]);
    expect(suggestedIntervals("Retire at 0 cycles").cycles).toBeUndefined();
  });
});

describe("page discovery", () => {
  it("skips contents entries, section headings and repeated names", () => {
    const rows = discoverPage(
      manualUuid,
      9,
      `(1) Inspect landing gear every 100 hours
(2) Table of contents ........ 4
(3) Inspection time limits
(4) Inspect landing gear every 100 hours
(5) Overhaul propeller every 2,000 hours`,
    );
    expect(rows.map((r) => [r.name, r.kind, r.hours])).toEqual([
      ["Inspect landing gear every 100 hours", "inspection", 100],
      ["Overhaul propeller every 2,000 hours", "component", 2000],
    ]);
  });
  it("keys a suggestion by a hash of its normalized text", () => {
    // Stored inspections hold this key; a different hash would offer items
    // already imported again.
    const [row] = discoverPage(
      manualUuid,
      9,
      "- Lubricate  hinges every 50 HRS",
    );
    expect(row.sourceKey).toBe(`${manualUuid}:9:2d2503a2`);
  });
  it("names an entry by its first line, at most 200 characters", () => {
    const [row] = discoverPage(
      manualUuid,
      9,
      `(1) Inspect ${"x".repeat(300)}\n(2) Replace seals`,
    );
    expect(row.name).toHaveLength(200);
  });
});
