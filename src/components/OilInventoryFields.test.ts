/**
 * Responsibility: Pins when the oil inventory fields show, which stock they
 *   offer, how they read once posted, and the inventory summary line.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/OilInventoryFields.tsx, src/data/demo.ts
 *   (demoSnapshot), src/domain/flightFluids.ts (OilReading type),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { OilReading } from "../domain/flightFluids";
import { OilInventoryFields, OilInventorySummary } from "./OilInventoryFields";

const snapshot = demoSnapshot();
snapshot.partsInventory = {
  locations: [
    { uuid: "L1", name: "Oil cabinet" },
    { uuid: "L2", name: "Hangar" },
  ],
  stock: [
    {
      uuid: "S1",
      locationUuid: "L1",
      partNumber: "OIL-1",
      description: "W100",
      quantity: 4,
      oil: true,
    },
    {
      uuid: "S2",
      locationUuid: "L1",
      partNumber: "OIL-2",
      description: "Old",
      quantity: 2,
      oil: true,
      expirationDate: "2001-01-01",
    },
    {
      uuid: "S3",
      locationUuid: "L1",
      partNumber: "FILTER",
      description: "Not oil",
      quantity: 9,
    },
    {
      uuid: "S4",
      locationUuid: "L2",
      partNumber: "OIL-3",
      description: "Hangar",
      quantity: 1,
      oil: true,
    },
  ],
};
vi.mock("../data/store", () => ({ useWorkspace: () => ({ snapshot }) }));

const reading = (over: Partial<OilReading>) =>
  ({ engine: 1, unit: "quarts", ...over }) as OilReading;
const inUse = (locationUuid: string, stockUuid: string, quantity = 2) =>
  reading({ added: 2, inventory: { locationUuid, stockUuid, quantity } });
const fields = (r: OilReading, readOnly = false) =>
  renderToStaticMarkup(
    createElement(OilInventoryFields, {
      label: "Engine oil",
      reading: r,
      onChange: () => {},
      readOnly,
    }),
  );
const summary = (r: OilReading) =>
  renderToStaticMarkup(createElement(OilInventorySummary, { reading: r }));

describe("OilInventoryFields", () => {
  it("shows nothing until oil is added or inventory use is recorded", () => {
    expect(fields(reading({}))).toBe("");
    expect(fields(reading({ added: 0 }))).toBe("");
    const html = fields(reading({ added: 1 }));
    expect(html).toContain("<span>Use inventory for engine oil</span>");
    expect(html).not.toContain("flight-grid");
  });

  it("offers only oil stock at the chosen location, expired oil disabled", () => {
    const html = fields(inUse("L1", "S1"));
    expect(html).toContain("Engine oil inventory location</label>");
    expect(html).toContain("Engine oil inventory part number</label>");
    expect(html).toContain("Engine oil stock units used</label>");
    expect(html).toContain(
      '<option value="S1" selected="">OIL-1 · W100 · 4 in stock</option>',
    );
    expect(html).toContain(
      '<option value="S2" disabled="">OIL-2 · Old · Expired 2001-01-01</option>',
    );
    expect(html).not.toMatch(/FILTER|OIL-3/);
  });

  it("keeps a location or part that is no longer in inventory visible", () => {
    const html = fields(inUse("GONE", "S9"));
    expect(html).toContain(
      '<option value="GONE" selected="">Unavailable location</option>',
    );
    expect(html).toContain(
      '<option value="S9" selected="">Unavailable part (S9)</option>',
    );
  });

  it("disables the fields and explains corrections once usage is posted", () => {
    const html = fields(inUse("L1", "S1"), true);
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain("This inventory usage is already posted.");
    expect(fields(inUse("L1", "S1"))).toContain(
      "Stock is deducted once when the flight syncs",
    );
  });
});

describe("OilInventorySummary", () => {
  it("names the quantity, part number and location", () => {
    expect(summary(inUse("L1", "S1"))).toBe(
      "<small>Inventory used: 2 × OIL-1 · Oil cabinet</small>",
    );
  });

  it("falls back for records no longer in inventory", () => {
    expect(summary(inUse("GONE", "S9", 1))).toBe(
      "<small>Inventory used: 1 × S9 · Unavailable location</small>",
    );
  });

  it("shows nothing when no inventory was drawn", () => {
    expect(summary(reading({ added: 1 }))).toBe("");
  });
});
