/**
 * Responsibility: Pins required-parts rules: list checks, availability
 *   against usable stock, and saving a discrepancy's parts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/requiredParts.ts, ./management, ./programs,
 *   ./partsPlanning, ./rejection, tests/fixtures (parts and work orders).
 */
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { describe, expect, it } from "vitest";
import { partsFixture, neededPart } from "../../tests/fixtures/requiredParts";
import {
  partsAvailability,
  partsInventory,
  validateRequiredParts,
  saveDiscrepancyParts,
} from "./requiredParts";
import { Rejection } from "./rejection";
import { applyManagement } from "./management";
import { scopedSnapshot } from "./programs";
import { maintenancePartsPlans } from "./partsPlanning";

describe("inventory parts planning", () => {
  it("compares quantities without issuing or reserving stock and updates after a receipt", () => {
    const s = partsFixture();
    saveDiscrepancyParts(s, "parts-report", 0, [neededPart]);
    expect(partsAvailability(s, [neededPart])[0]).toMatchObject({
      available: 2,
      shortage: 1,
    });
    expect(s.management?.find((r) => r.uuid === "parts-stock")).toMatchObject({
      quantity: 2,
    });
    applyManagement(s, {
      action: "stock.move",
      uuid: "parts-stock",
      version: 1,
      operation: "receive",
      quantity: 2,
      requestUuid: crypto.randomUUID(),
      reason: "Delivery received",
    });
    expect(partsAvailability(s, [neededPart])[0]).toMatchObject({
      available: 4,
      shortage: 0,
    });
    expect(
      partsAvailability(s, [{ ...neededPart, stockUuid: "missing" }])[0]
        .available,
    ).toBeUndefined();
  });
  it("does not count expired stock as available, so its shortage shows (#40)", () => {
    const s = partsFixture();
    const stock = s.management!.find((r) => r.uuid === "parts-stock")!;
    if (stock.kind !== "stock") throw Error("fixture");
    stock.expirationDate = "2026-10-18";
    const now = Date.parse("2026-10-20T12:00:00Z");
    const byPartNumber = {
      ...neededPart,
      stockUuid: "",
      partNumber: "FILTER-1",
    };
    expect(partsAvailability(s, [neededPart], now)[0]).toMatchObject({
      available: 0,
      shortage: 3,
      expired: 2,
    });
    expect(partsAvailability(s, [byPartNumber], now)[0]).toMatchObject({
      available: 0,
      shortage: 3,
      expired: 2,
    });
    // Readers see the same through the scoped inventory.
    expect(
      partsAvailability(scopedSnapshot(s), [neededPart], now)[0],
    ).toMatchObject({ available: 0, shortage: 3 });
    // Usable through its expiration date, exactly as reserving allows.
    stock.expirationDate = "2026-10-21";
    expect(partsAvailability(s, [neededPart], now)[0]).toMatchObject({
      available: 2,
      shortage: 1,
      expired: 0,
    });
  });
  it("rejects wrong locations, cross-program links, duplicate parts and invalid quantities", () => {
    const s = partsFixture();
    expect(() =>
      validateRequiredParts(
        s,
        [{ ...neededPart, locationUuid: "other-location" }],
        "demo-program",
      ),
    ).toThrow("location");
    expect(() =>
      validateRequiredParts(s, [neededPart], "other-program"),
    ).toThrow("Flight Program");
    expect(() =>
      validateRequiredParts(s, [neededPart, neededPart], "demo-program"),
    ).toThrow("already listed");
    for (const quantity of [0, -1, 1.5, Infinity])
      expect(() =>
        validateRequiredParts(s, [{ ...neededPart, quantity }], "demo-program"),
      ).toThrow();
  });
  it("keeps discrepancy changes permission checked, versioned and immutable after resolution", () => {
    const s = partsFixture();
    saveDiscrepancyParts(s, "parts-report", 0, [neededPart]);
    expect(() => saveDiscrepancyParts(s, "parts-report", 0, [])).toThrow(
      "changed",
    );
    s.user.isAdmin = false;
    expect(() => saveDiscrepancyParts(s, "parts-report", 1, [])).toThrow(
      "Permission",
    );
    s.user.isAdmin = true;
    s.discrepancies[0].status = "resolved";
    expect(() => saveDiscrepancyParts(s, "parts-report", 1, [])).toThrow(
      "read-only",
    );
  });
  it("shows readers current availability without exposing purchasing details or another program", () => {
    const s = partsFixture();
    s.user.isAdmin = false;
    s.user.groupIds = ["readers"];
    s.groups = [
      {
        id: "readers",
        name: "Readers",
        programUuid: "demo-program",
        permissions: ["read"],
        aircraftIds: [s.aircraft[0].uuid],
      },
    ];
    s.management!.push({
      kind: "location",
      uuid: "foreign",
      programUuid: "foreign-program",
      version: 1,
      name: "Hidden",
      address: "",
      contact: "",
    });
    const scoped = scopedSnapshot(s);
    expect(scoped.management).toEqual([]);
    expect(partsAvailability(scoped, [neededPart])[0]).toMatchObject({
      available: 2,
      shortage: 1,
    });
    expect(JSON.stringify(scoped.partsInventory)).not.toMatch(
      /Private vendor|cost|Hidden/,
    );
  });
  it("persists inspection links through edits and excludes archived/resolved work from plans", () => {
    const s = partsFixture();
    const i = s.inspections[0];
    applyManagement(s, {
      action: "inspection.save",
      record: {
        ...i,
        version: i.version ?? 0,
        materials: "",
        archived: false,
        requiredParts: [neededPart],
      },
      requestUuid: crypto.randomUUID(),
      reason: "Plan parts",
    });
    expect(s.inspections.find((r) => r.uuid === i.uuid)?.requiredParts).toEqual(
      [neededPart],
    );
    saveDiscrepancyParts(s, "parts-report", 0, [neededPart]);
    expect(maintenancePartsPlans(s).map((p) => p.uuid)).toEqual(
      expect.arrayContaining([i.uuid, "parts-report"]),
    );
    s.inspections.find((r) => r.uuid === i.uuid)!.archived = true;
    s.discrepancies[0].status = "resolved";
    expect(maintenancePartsPlans(s)).toHaveLength(0);
  });
});

it("saves component service parts and flags upcoming installed component requirements", () => {
  const s = partsFixture();
  const c = workOrderComponent();
  s.management!.push(c);
  applyManagement(s, {
    action: "record.save",
    requestUuid: crypto.randomUUID(),
    reason: "Plan component service",
    record: {
      kind: "componentRequirement",
      uuid: "service",
      version: 0,
      componentUuid: c.uuid,
      aircraftUuid: c.aircraftUuid,
      description: "Oil service",
      notes: "",
      requirementType: "Inspection Requirement",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      intervalSeconds: 111 * 3600,
      warningSeconds: 10 * 3600,
      warningCycles: 0,
      warningCalendarMonths: 0,
      requiredParts: [neededPart],
    },
  });
  expect(s.management!.find((r) => r.uuid === "service")).toMatchObject({
    requiredParts: [neededPart],
  });
  expect(maintenancePartsPlans(s)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ uuid: "service", upcoming: true }),
    ]),
  );
  c.installed = false;
  expect(maintenancePartsPlans(s).some((p) => p.uuid === "service")).toBe(
    false,
  );
});

it("refuses bad lists and stale or closed reports as a Rejection", () => {
  const s = partsFixture();
  const refusal = (attempt: () => unknown) => {
    try {
      attempt();
    } catch (error) {
      return error;
    }
  };
  const save = (uuid: string, version: number) => () =>
    saveDiscrepancyParts(s, uuid, version, []);
  const resolved = () => {
    s.discrepancies[0].status = "resolved";
    return saveDiscrepancyParts(s, "parts-report", 0, []);
  };
  for (const [attempt, message] of [
    [
      () => validateRequiredParts(s, [neededPart], "other-program"),
      "Select a part and inventory location in this Flight Program.",
    ],
    [
      () => validateRequiredParts(s, [neededPart, neededPart], "demo-program"),
      "This part is already listed. Update its quantity instead.",
    ],
    [save("missing", 0), "Report not found."],
    [
      save("parts-report", 1),
      "Parts changed. Reopen the report and try again.",
    ],
    [resolved, "Resolved reports are read-only."],
  ] as const) {
    const error = refusal(attempt);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toHaveProperty("message", message);
  }
  s.discrepancies[0].status = "open";
  s.user.isAdmin = false;
  expect(refusal(save("parts-report", 0))).toEqual(
    new Rejection("Permission denied."),
  );
  expect(refusal(save("parts-report", 0))).toBeInstanceOf(Rejection);
});

it("moves the parts version on by one and keeps the parsed list", () => {
  const s = partsFixture();
  const d = saveDiscrepancyParts(s, "parts-report", 0, [
    { ...neededPart, partNumber: "dropped" },
  ]);
  expect(d).toBe(s.discrepancies[0]);
  expect(d).toMatchObject({ partsVersion: 1, requiredParts: [neededPart] });
  expect(validateRequiredParts(s, undefined, "demo-program")).toEqual([]);
});

it("adds up the need for one lot and labels missing stock", () => {
  const s = partsFixture();
  const rows = partsAvailability(s, [
    neededPart,
    { ...neededPart, quantity: 1 },
    { ...neededPart, stockUuid: "missing", locationUuid: "nowhere" },
  ]);
  expect(rows.map((r) => [r.available, r.shortage, r.expired])).toEqual([
    [2, 2, 0],
    [2, 2, 0],
    [undefined, undefined, undefined],
  ]);
  expect(rows[2]).toMatchObject({
    partNumber: "Unavailable part",
    location: "Unavailable location",
  });
  expect(rows[0]).toMatchObject({
    partNumber: "FILTER-1",
    location: "Main hangar",
  });
});

it("counts serviceable lots of a part number, at its location if given", () => {
  const s = partsFixture();
  const inventory = partsInventory(s);
  const lot = (uuid: string, locationUuid: string, condition?: string) => ({
    ...inventory.stock[0],
    uuid,
    locationUuid,
    condition,
  });
  inventory.stock.push(
    lot("overhauled", "other-location", "overhauled"),
    lot("unmarked", "other-location"),
    lot("as-removed", "other-location", "as removed"),
  );
  s.partsInventory = inventory;
  const byNumber = {
    stockUuid: "",
    locationUuid: "",
    partNumber: "FILTER-1",
    quantity: 7,
  };
  expect(partsAvailability(s, [byNumber])[0]).toMatchObject({
    location: "All locations",
    available: 6,
    shortage: 1,
  });
  expect(
    partsAvailability(s, [
      { ...byNumber, locationUuid: "other-location", quantity: 1 },
    ])[0],
  ).toMatchObject({ location: "Remote hangar", available: 4, shortage: 0 });
});

it("prefers a snapshot's own parts inventory and defaults reservations to 0", () => {
  const s = partsFixture();
  expect(partsInventory(s).stock[0]).toMatchObject({
    uuid: "parts-stock",
    reservedQuantity: 0,
  });
  s.partsInventory = { locations: [], stock: [] };
  expect(partsInventory(s)).toBe(s.partsInventory);
});
