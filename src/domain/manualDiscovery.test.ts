import { expect, it } from "vitest";
import {
  discoverPage,
  suggestedIntervals,
  matchesAircraft,
  matchesComponent,
} from "./manualDiscovery";
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
