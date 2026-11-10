/**
 * Responsibility: Pins work-order costs: parsing and pricing labor, parts and
 *   other costs, the aircraft cost report, budgets, and every refusal.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/costs.ts, ./workOrders, ./partsRequests,
 *   ./programs, ./csv, ./model, ./rejection, src/data/demo.ts,
 *   tests/fixtures/workOrders.ts.
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { saveWorkOrder } from "./workOrders";
import { partsRequestSchema } from "./partsRequests";
import { scopedSnapshot } from "./programs";
import { toCsv } from "./csv";
import type { Flight, Snapshot } from "./model";
import { Rejection } from "./rejection";
import {
  aircraftCostReport,
  applyCostCommand,
  budgetStatus,
  costRecordSchema,
  costReportCsvRows,
  flightSeconds,
  formatCents,
  formatLaborHours,
  laborCents,
  parseCents,
  parseLaborHours,
  periodFor,
  workOrderCosts,
  type CostCommand,
} from "./costs";
const NOW = Date.parse("2026-06-15T12:00:00");
const localNoon = (d: string) => Date.parse(`${d}T12:00:00`);
function fixture() {
  const s = demoSnapshot();
  const command = workOrderCommand();
  const order = saveWorkOrder(s, command, NOW);
  s.management = [
    {
      uuid: "store",
      version: 1,
      programUuid: "demo-program",
      kind: "location",
      name: "Store",
      address: "",
      contact: "",
    },
    {
      uuid: "filter",
      version: 1,
      programUuid: "demo-program",
      kind: "stock",
      partNumber: "OF-1",
      description: "Oil filter",
      category: "part",
      condition: "new",
      locationUuid: "store",
      quantity: 5,
      minimum: 0,
      alternates: "",
      cost: 12.35,
    },
    {
      uuid: "gasket",
      version: 1,
      programUuid: "demo-program",
      kind: "stock",
      partNumber: "GK-1",
      description: "Gasket",
      category: "part",
      condition: "new",
      locationUuid: "store",
      quantity: 5,
      minimum: 0,
      alternates: "",
    },
  ];
  s.partsRequests = [
    partsRequestSchema.parse({
      uuid: "req",
      version: 3,
      source: { kind: "workTask", uuid: "task", workOrderUuid: order.uuid },
      mode: "parts",
      date: "2026-03-01",
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [
        {
          uuid: "l1",
          partNumber: "OF-1",
          description: "Oil filter",
          quantity: 3,
        },
        { uuid: "l2", partNumber: "GK-1", description: "Gasket", quantity: 1 },
      ],
      programUuid: "demo-program",
      aircraftUuid: order.aircraftUuid,
      sourceLabel: "WO",
      aircraftRegistration: "",
      aircraftSerial: "",
      aircraftModel: "",
      number: "PR-1",
      requesterId: "demo-admin",
      createdAt: 0,
      updatedAt: 0,
      cancelled: false,
      reservations: [],
      issues: [
        {
          lineUuid: "l1",
          stockUuid: "filter",
          quantity: 2,
          at: localNoon("2026-03-31"),
          actorId: "demo-admin",
        },
        {
          lineUuid: "l1",
          stockUuid: "filter",
          quantity: 1,
          at: localNoon("2026-04-01"),
          actorId: "demo-admin",
        },
        {
          lineUuid: "l2",
          stockUuid: "gasket",
          quantity: 1,
          at: localNoon("2026-04-01"),
          actorId: "demo-admin",
        },
      ],
      history: [],
    }),
  ];
  const run = (c: CostCommand, now = NOW) => applyCostCommand(s, c, now);
  return { s, order, run };
}
function asMaintenance(s: Snapshot) {
  s.groups.push({
    id: "mx",
    name: "Maintenance",
    programUuid: "demo-program",
    aircraftIds: [],
    permissions: ["read", "maintenance"],
  });
  s.user = {
    ...s.user,
    id: "tech",
    name: "Tech",
    isAdmin: false,
    groupIds: ["mx"],
  };
}
describe("cost parsing and math", () => {
  it("parses decimal hours to integer seconds and money to integer cents", () => {
    expect(parseLaborHours("1.5")).toBe(5400);
    expect(parseLaborHours("0.25")).toBe(900);
    expect(() => parseLaborHours("0")).toThrow("greater than zero");
    expect(() => parseLaborHours("1.234")).toThrow();
    expect(() => parseLaborHours("-1")).toThrow();
    expect(() => parseLaborHours("1001")).toThrow("1,000");
    expect(parseCents("0.29")).toBe(29);
    expect(parseCents("$1,234.5")).toBe(123450);
    // A decimal comma is refused, never read as a 100x larger amount.
    expect(() => parseCents("45,50")).toThrow(
      "Use a point for decimals, as in 2342.5, and leave out thousands commas.",
    );
    expect(() => parseCents("$1,234")).toThrow("Use a point for decimals");
    expect(parseCents("19.99")).toBe(1999);
    expect(() => parseCents("1.999")).toThrow();
    expect(() => parseCents("-5")).toThrow();
    expect(() => parseCents("99999999999999")).toThrow("too large");
  });
  it("multiplies hours by rate and rounds each entry to the cent", () => {
    expect(laborCents({ minutes: 90, rateCents: 9500 })).toBe(14250);
    // 7 minutes at $85.55/h = 998.083… cents
    expect(laborCents({ minutes: 7, rateCents: 8555 })).toBe(998);
    expect(laborCents({ minutes: 1, rateCents: 1 })).toBe(0);
    expect(laborCents({ minutes: 60 })).toBe(0);
  });
});
describe("exact labor hours (#46)", () => {
  it("stores hours with two decimals exactly and prices them to the cent", () => {
    expect(parseLaborHours("1.33")).toBe(4788);
    expect(parseLaborHours("1.5")).toBe(5400);
    expect(parseLaborHours("0.01")).toBe(36);
    expect(parseLaborHours("1000")).toBe(3600000);
    const { s, order, run } = fixture();
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-02",
        technician: "Sam",
        seconds: parseLaborHours("1.33"),
        rateCents: 10000,
      },
    });
    const costs = workOrderCosts(s, order);
    // Whole minutes are still written for app versions that only read them.
    expect(costs.labor[0]).toMatchObject({ seconds: 4788, minutes: 80 });
    expect(laborCents(costs.labor[0])).toBe(13300);
    expect(costs.laborCents).toBe(13300);
    expect(costs.laborSeconds).toBe(4788);
    expect(formatLaborHours(costs.laborSeconds)).toBe("1.33");
    const report = aircraftCostReport(s, order.aircraftUuid, {
      from: "2026-04-02",
      to: "2026-04-02",
    });
    const [row, total] = costReportCsvRows(report);
    expect(row).toMatchObject({ "Labor hours": 1.33, Labor: 133 });
    expect(total).toMatchObject({ "Labor hours": 1.33, Labor: 133 });
    expect(toCsv([row])).toContain('"1.33","133"');
  });
  it("keeps the amounts of entries stored in whole minutes", () => {
    const { s, order, run } = fixture();
    // An entry saved before exact hours (or by an older app): 1.33 h was
    // stored as 80 minutes and charged $133.33.
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-02",
        technician: "Sam",
        minutes: 80,
        rateCents: 10000,
      },
    });
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-02",
        technician: "Lee",
        seconds: 4788,
        rateCents: 10000,
      },
    });
    const costs = workOrderCosts(s, order);
    expect(costs.labor[0]).not.toHaveProperty("seconds");
    expect(costs.labor.map(laborCents)).toEqual([13333, 13300]);
    expect(costs.laborSeconds).toBe(4800 + 4788);
    expect(formatLaborHours(4800)).toBe("1.33");
    // A stored row of the old shape still parses unchanged.
    const stored = s.costs!.find((r) => r.kind === "workOrder")!;
    expect(costRecordSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(
      stored,
    );
  });
  it("needs labor time, and refuses more than 1,000 hours either way", () => {
    const { order, run } = fixture();
    const entry = {
      uuid: crypto.randomUUID(),
      date: "2026-04-02",
      technician: "Sam",
    };
    for (const time of [{}, { seconds: 0 }, { seconds: 3600001 }])
      expect(() =>
        run({
          action: "labor.add",
          workOrderUuid: order.uuid,
          entry: { ...entry, ...time },
        } as CostCommand),
      ).toThrow();
  });
});
describe("work order costs", () => {
  it("totals labor, parts (stock cost or manual) and other costs", () => {
    const { s, order, run } = fixture();
    run({ action: "settings.laborRate", laborRateCents: 10000 });
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-02",
        technician: "Sam",
        minutes: 90,
      },
    });
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-03",
        technician: "Lee",
        minutes: 30,
        rateCents: 12001,
      },
    });
    run({
      action: "other.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-03",
        description: "Shop supplies",
        amountCents: 2500,
      },
    });
    let costs = workOrderCosts(s, order);
    expect(costs.laborSeconds).toBe(120 * 60);
    expect(costs.laborCents).toBe(15000 + 6001);
    expect(costs.parts).toMatchObject([
      { stockUuid: "filter", quantity: 3, unitCents: 1235, totalCents: 3705 },
      { stockUuid: "gasket", quantity: 1, unitCents: undefined, totalCents: 0 },
    ]);
    expect(costs.missingPartCosts).toBe(1);
    run({
      action: "part.unitCost",
      workOrderUuid: order.uuid,
      stockUuid: "gasket",
      unitCents: 450,
    });
    costs = workOrderCosts(s, order);
    expect(costs.partsCents).toBe(3705 + 450);
    expect(costs.missingPartCosts).toBe(0);
    expect(costs.totalCents).toBe(21001 + 4155 + 2500);
    expect(() =>
      run({
        action: "part.unitCost",
        workOrderUuid: order.uuid,
        stockUuid: "nope",
        unitCents: 1,
      }),
    ).toThrow("not issued");
    run({
      action: "part.unitCost",
      workOrderUuid: order.uuid,
      stockUuid: "gasket",
      unitCents: null,
    });
    expect(workOrderCosts(s, order).missingPartCosts).toBe(1);
  });
  it("lets maintenance add hours at the program rate but never set rates or money", () => {
    const { s, order, run } = fixture();
    run({ action: "settings.laborRate", laborRateCents: 9000 });
    asMaintenance(s);
    const entry = {
      uuid: crypto.randomUUID(),
      date: "2026-04-02",
      technician: "Tech",
      minutes: 60,
    };
    run({ action: "labor.add", workOrderUuid: order.uuid, entry });
    // Replays are idempotent.
    run({ action: "labor.add", workOrderUuid: order.uuid, entry });
    expect(workOrderCosts(s, order).labor).toHaveLength(1);
    expect(workOrderCosts(s, order).laborCents).toBe(9000);
    expect(() =>
      run({
        action: "labor.add",
        workOrderUuid: order.uuid,
        entry: { ...entry, uuid: crypto.randomUUID(), rateCents: 1 },
      }),
    ).toThrow("administrators");
    for (const c of [
      {
        action: "other.add",
        workOrderUuid: order.uuid,
        entry: {
          uuid: crypto.randomUUID(),
          date: "2026-04-02",
          description: "x",
          amountCents: 1,
        },
      },
      {
        action: "budget.set",
        aircraftUuid: order.aircraftUuid,
        year: 2026,
        amountCents: 1,
      },
      { action: "settings.laborRate", laborRateCents: 1 },
      {
        action: "part.unitCost",
        workOrderUuid: order.uuid,
        stockUuid: "gasket",
        unitCents: 1,
      },
    ] as CostCommand[])
      expect(() => run(c)).toThrow("administrator");
    // Non-admin snapshot: hours only; no rates, money, budgets, settings or cost audit.
    const scoped = scopedSnapshot(s);
    expect(scoped.costs).toHaveLength(1);
    const record = scoped.costs![0];
    expect(record.kind === "workOrder" && record.labor[0]).not.toHaveProperty(
      "rateCents",
    );
    expect(record.kind === "workOrder" && record.labor[0].minutes).toBe(60);
    expect(scoped.audit.some((a) => a.action.startsWith("cost."))).toBe(false);
  });
  it("only removes a maintenance user's own labor", () => {
    const { s, order, run } = fixture();
    const adminEntry = crypto.randomUUID();
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: adminEntry,
        date: "2026-04-02",
        technician: "Boss",
        minutes: 60,
      },
    });
    asMaintenance(s);
    expect(() =>
      run({
        action: "labor.remove",
        workOrderUuid: order.uuid,
        uuid: adminEntry,
      }),
    ).toThrow("only remove");
  });
  it("freezes costs once the work order is closed and rejects future dates", () => {
    const { s, order, run } = fixture();
    expect(() =>
      run({
        action: "labor.add",
        workOrderUuid: order.uuid,
        entry: {
          uuid: crypto.randomUUID(),
          date: "2026-07-01",
          technician: "Sam",
          minutes: 60,
        },
      }),
    ).toThrow("future");
    saveWorkOrder(
      s,
      {
        ...workOrderCommand(),
        uuid: order.uuid,
        version: order.version,
        fields: {
          ...workOrderCommand().fields,
          status: "cancelled",
          number: order.number,
        },
      },
      NOW,
    );
    expect(() =>
      run({
        action: "labor.add",
        workOrderUuid: order.uuid,
        entry: {
          uuid: crypto.randomUUID(),
          date: "2026-04-02",
          technician: "Sam",
          minutes: 60,
        },
      }),
    ).toThrow("read-only");
  });
});
describe("aircraft cost report", () => {
  it("filters by inclusive period boundaries and guards cost per hour", () => {
    const { s, order, run } = fixture();
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-03-31",
        technician: "A",
        minutes: 60,
        rateCents: 6000,
      },
    });
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-01",
        technician: "B",
        minutes: 60,
        rateCents: 7000,
      },
    });
    const april = { from: "2026-04-01", to: "2026-04-30" };
    let report = aircraftCostReport(s, order.aircraftUuid, april);
    expect(report.laborCents).toBe(7000);
    expect(report.partsCents).toBe(1235); // filter issued 04-01; gasket has no cost
    expect(report.missingPartCosts).toBe(1);
    expect(report.flightSeconds).toBe(0);
    expect(report.costPerHourCents).toBeUndefined();
    const march = aircraftCostReport(s, order.aircraftUuid, {
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(march.totalCents).toBe(6000 + 2 * 1235);
    expect(
      aircraftCostReport(s, order.aircraftUuid, {
        from: "2026-05-01",
        to: "2026-05-31",
      }).orders,
    ).toHaveLength(0);
    const a = s.aircraft.find((x) => x.uuid === order.aircraftUuid)!;
    s.flights = [
      {
        startTime: new Date(localNoon("2026-04-30")).toISOString(),
        hobbsOff: a.currentHobbs,
        hobbsOn: a.currentHobbs + 2 * 3600,
      },
      {
        startTime: new Date(localNoon("2026-05-01")).toISOString(),
        hobbsOff: a.currentHobbs,
        hobbsOn: a.currentHobbs + 3600,
      },
    ].map((f, i) => ({
      ...f,
      uuid: `f${i}`,
      aircraftUuid: a.uuid,
      pilotId: "demo-admin",
      authorId: "demo-admin",
      submittedAt: 0,
      status: "accepted",
      landings: 1,
      cycles: 1,
      origin: "",
      destination: "",
      operation: "Mission",
      flightRules: "VFR",
      remarks: "",
      discrepancy: "",
    }));
    report = aircraftCostReport(s, order.aircraftUuid, april);
    expect(report.flightSeconds).toBe(7200);
    expect(report.costPerHourCents).toBe(Math.round((7000 + 1235) / 2));
    const csv = toCsv(costReportCsvRows(report));
    expect(csv).toContain('"Cost per flight hour"');
    expect(csv).toContain('"82.35"');
  });
  it("computes period presets", () => {
    expect(periodFor("year", "2026-10-30")).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(periodFor("12m", "2026-10-30")).toEqual({
      from: "2025-10-31",
      to: "2026-10-30",
    });
    expect(periodFor("12m", "2024-02-29")).toEqual({
      from: "2023-03-01",
      to: "2024-02-29",
    });
    expect(periodFor("12m", "2026-01-01")).toEqual({
      from: "2025-01-02",
      to: "2026-01-01",
    });
    expect(() =>
      periodFor("custom", "2026-01-01", {
        from: "2026-02-01",
        to: "2026-01-01",
      }),
    ).toThrow("on or before");
    expect(() =>
      periodFor("custom", "2026-01-01", { from: "", to: "2026-01-01" }),
    ).toThrow();
  });
  it("compares the annual budget with actual spend", () => {
    const { s, order, run } = fixture();
    expect(
      budgetStatus(s, order.aircraftUuid, 2026).budgetCents,
    ).toBeUndefined();
    run({
      action: "budget.set",
      aircraftUuid: order.aircraftUuid,
      year: 2026,
      amountCents: 10000,
    });
    run({
      action: "labor.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-05-01",
        technician: "A",
        minutes: 60,
        rateCents: 5000,
      },
    });
    let status = budgetStatus(s, order.aircraftUuid, 2026);
    // 3 filters at 12.35 + 50.00 labor
    expect(status).toMatchObject({
      budgetCents: 10000,
      actualCents: 8705,
      remainingCents: 1295,
      percent: 87,
      over: false,
    });
    run({
      action: "budget.set",
      aircraftUuid: order.aircraftUuid,
      year: 2026,
      amountCents: 5000,
    });
    expect(s.costs!.filter((r) => r.kind === "budget")).toHaveLength(1);
    status = budgetStatus(s, order.aircraftUuid, 2026);
    expect(status).toMatchObject({
      remainingCents: -3705,
      over: true,
      percent: 174,
    });
    expect(budgetStatus(s, order.aircraftUuid, 2025).actualCents).toBe(0);
    // Negative values stay numeric in CSV (not formula-escaped text).
    expect(toCsv([{ Remaining: status.remainingCents! / 100 }])).toContain(
      '"-37.05"',
    );
  });
  it("keeps other programs' cost records out of the scoped snapshot", () => {
    const { s, order, run } = fixture();
    run({ action: "settings.laborRate", laborRateCents: 100 });
    s.costs!.push({
      uuid: "foreign",
      version: 1,
      programUuid: "other",
      kind: "settings",
      laborRateCents: 1,
    });
    s.costs!.push({
      uuid: "foreign-b",
      version: 1,
      programUuid: "other",
      kind: "budget",
      aircraftUuid: "other-aircraft",
      year: 2026,
      amountCents: 1,
    });
    const scoped = scopedSnapshot(s);
    expect(scoped.costs!.map((r) => r.uuid)).not.toContain("foreign");
    expect(scoped.costs!.map((r) => r.uuid)).not.toContain("foreign-b");
    expect(() =>
      run({
        action: "budget.set",
        aircraftUuid: "other-aircraft",
        year: 2026,
        amountCents: 1,
      }),
    ).toThrow("not found");
    expect(() =>
      run({ action: "labor.remove", workOrderUuid: "missing", uuid: "x" }),
    ).toThrow("not found");
    expect(order).toBeTruthy();
  });
});

describe("cost report details", () => {
  it("formats cents as US dollars", () => {
    expect(formatCents(123450)).toBe("$1,234.50");
  });
  it("lists work orders oldest opened first", () => {
    const f = fixture();
    const older = {
      ...f.order,
      uuid: crypto.randomUUID(),
      dateOpened: "2025-12-31",
    };
    f.s.workOrders = [...f.s.workOrders!, older];
    f.run(labor(f));
    f.run({ ...labor(f), workOrderUuid: older.uuid } as CostCommand);
    const report = aircraftCostReport(f.s, f.order.aircraftUuid, {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(report.orders.map((o) => o.order.uuid)).toEqual([
      older.uuid,
      f.order.uuid,
    ]);
  });
  it("counts only accepted flights", () => {
    const { s } = fixture();
    const a = s.aircraft[0];
    const flight = {
      ...demoFlight(a.uuid),
      hobbsOff: a.currentHobbs,
      hobbsOn: a.currentHobbs + 3600,
    };
    expect(flightSeconds(a, flight)).toBe(3600);
    expect(flightSeconds(a, { ...flight, status: "review" })).toBe(0);
  });
  it("gives no percent for a zero budget, and keeps budgets per year", () => {
    const f = fixture();
    const budget = (year: number, amountCents: number) =>
      f.run({
        action: "budget.set",
        aircraftUuid: f.order.aircraftUuid,
        year,
        amountCents,
      });
    budget(2025, 100);
    budget(2026, 0);
    expect(budgetStatus(f.s, f.order.aircraftUuid, 2026)).toMatchObject({
      budgetCents: 0,
      percent: undefined,
      over: true,
    });
  });
});

function demoFlight(aircraftUuid: string): Flight {
  return {
    uuid: "flight",
    aircraftUuid,
    startTime: new Date(localNoon("2026-04-30")).toISOString(),
    pilotId: "demo-admin",
    authorId: "demo-admin",
    submittedAt: 0,
    status: "accepted",
    landings: 1,
    cycles: 1,
    origin: "",
    destination: "",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  } as Flight;
}

type Fixture = ReturnType<typeof fixture>;
const labor = ({ order }: Fixture, entry: object = {}): CostCommand => ({
  action: "labor.add",
  workOrderUuid: order.uuid,
  entry: {
    uuid: crypto.randomUUID(),
    date: "2026-06-01",
    technician: "Sam",
    seconds: 3600,
    ...entry,
  },
});
const closeOrder = ({ s, order }: Fixture) =>
  saveWorkOrder(
    s,
    {
      ...workOrderCommand(),
      uuid: order.uuid,
      version: order.version,
      fields: {
        ...workOrderCommand().fields,
        status: "cancelled",
        number: order.number,
      },
    },
    NOW,
  );

// Each refusal costs.ts throws itself.
const REFUSALS: Record<string, (f: Fixture) => unknown> = {
  "Enter hours as a number with up to two decimals.": () =>
    parseLaborHours("1.234"),
  "Labor hours must be greater than zero.": () => parseLaborHours("0"),
  "A single labor entry cannot exceed 1,000 hours.": () =>
    parseLaborHours("1000.01"),
  "Enter a positive amount with up to two decimals.": () => parseCents("-1"),
  "Amount is too large.": () => parseCents("1.00", 99),
  "Choose a start and end date.": () =>
    periodFor("custom", "2026-06-15", { from: "2026-01-01" }),
  "Choose a start date on or before the end date.": () =>
    periodFor("custom", "2026-06-15", { from: "2026-02-01", to: "2026-01-31" }),
  "Select a Flight Program first.": (f) => {
    f.s.user = { ...f.s.user, active: false };
    return f.run({ action: "settings.laborRate", laborRateCents: 1 });
  },
  "Flight Program administrator access is required.": (f) => {
    asMaintenance(f.s);
    return f.run({ action: "settings.laborRate", laborRateCents: 1 });
  },
  "Aircraft not found.": (f) =>
    f.run({
      action: "budget.set",
      aircraftUuid: "missing",
      year: 2026,
      amountCents: 1,
    }),
  "Work order not found.": (f) =>
    f.run({ action: "labor.remove", workOrderUuid: "missing", uuid: "x" }),
  "This work order is closed. Its costs are read-only.": (f) => {
    closeOrder(f);
    return f.run(labor(f));
  },
  "Cost dates cannot be in the future.": (f) =>
    f.run(labor(f, { date: "2099-01-01" })),
  "Only Flight Program administrators can set rates.": (f) => {
    asMaintenance(f.s);
    return f.run(labor(f, { rateCents: 100 }));
  },
  "Labor entry not found.": (f) =>
    f.run({ action: "labor.remove", workOrderUuid: f.order.uuid, uuid: "x" }),
  "You can only remove labor you recorded.": (f) => {
    const command = labor(f);
    f.run(command);
    asMaintenance(f.s);
    const uuid = command.action === "labor.add" ? command.entry.uuid : "";
    return f.run({ action: "labor.remove", workOrderUuid: f.order.uuid, uuid });
  },
  "Cost entry not found.": (f) =>
    f.run({ action: "other.remove", workOrderUuid: f.order.uuid, uuid: "x" }),
  "That part was not issued to this work order.": (f) =>
    f.run({
      action: "part.unitCost",
      workOrderUuid: f.order.uuid,
      stockUuid: "missing",
      unitCents: 1,
    }),
};

describe("change log", () => {
  it("writes one row per change, with the program and no aircraft", () => {
    const { s, run } = fixture();
    const [aircraft] = s.aircraft;
    run({
      action: "budget.set",
      aircraftUuid: aircraft.uuid,
      year: 2026,
      amountCents: 100,
    });
    const [row] = s.audit;
    expect(Object.keys(JSON.parse(JSON.stringify(row)))).toEqual([
      "uuid",
      "programUuid",
      "actorId",
      "at",
      "action",
      "entityUuid",
      "reason",
      "after",
    ]);
    expect(row).toMatchObject({
      programUuid: "demo-program",
      actorId: s.user.id,
      at: NOW,
      action: "cost.budget.set",
      reason: aircraft.registration,
    });
    expect(row.aircraftUuid).toBeUndefined();
  });
});

describe("refusals", () => {
  it.each(Object.entries(REFUSALS))("%s", (message, refuse) => {
    const f = fixture();
    const error = thrownBy(() => refuse(f));
    expect(error).toEqual(new Error(message));
    expect(error).toBeInstanceOf(Rejection);
  });
});

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal.");
}
