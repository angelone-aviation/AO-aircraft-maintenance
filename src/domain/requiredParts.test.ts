import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { describe, expect, it } from "vitest";
import { partsFixture, neededPart } from "../../tests/fixtures/requiredParts";
import {
  partsAvailability,
  validateRequiredParts,
  saveDiscrepancyParts,
} from "./requiredParts";
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
