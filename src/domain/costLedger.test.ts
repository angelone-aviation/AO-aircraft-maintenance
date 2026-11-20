/**
 * Responsibility: Pins the cost ledger's rows (ADR-0013, stage S4): a work
 *   order's days sum to its costs over any period at the prices its records
 *   fix, and the cost report its rows give.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain (costs, costs/ledger, partsRequests, taskCards,
 *   workOrders, management, model), src/data/demo.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  ledgerCostReport,
  ledgerTotals,
  workOrderLedger,
  type LedgerRow,
} from "./costs/ledger";
import { costRecordSchema, workOrderCosts, type Period } from "./costs";
import { partsRequestSchema, requestDraftSchema } from "./partsRequests";
import { taskCardDefaults, taskCardSchema } from "./taskCards";
import { workOrderSchema, type WorkOrder } from "./workOrders";
import { recordSchema } from "./management";
import type { Snapshot } from "./model";

const PROGRAM = "demo-program";
const RATE_CENTS = 9500;
const STOCK_DOLLARS = 10;
const RECORDED_CENTS = 1200;
const MANUAL_CENTS = 900;
const MONTHS = 12;

describe("a work order's ledger", () => {
  it("sums over every month, quarter, day and the year to its costs with stock costs left out", () => {
    const { s, order } = fixture();
    const days = workOrderLedger(s, order);
    const noStock = { ...s, management: [] };
    for (const period of periods(days.map((d) => d.date))) {
      const costs = workOrderCosts(noStock, order, period);
      expect(ledgerTotals(days, period), JSON.stringify(period)).toEqual({
        laborSeconds: costs.laborSeconds,
        laborCents: costs.laborCents,
        partsCents: costs.partsCents,
        otherCents: costs.otherCents,
        totalCents: costs.totalCents,
      });
    }
  });

  it("prices an issue at its manual or recorded cost, and an older unpriced one at nothing, whatever the stock costs now", () => {
    const { s, order } = fixture();
    const days = workOrderLedger(s, order);
    expect(days.map((d) => [d.date, d.partsCents])).toEqual([
      ["2026-03-02", 2 * RECORDED_CENTS],
      // Issued before D13, priced only by the stock's current cost.
      ["2026-04-10", 0],
      ["2026-05-05", 3 * MANUAL_CENTS],
      ["2026-06-01", 0],
    ]);
    expect(
      workOrderCosts(s, order, { from: "2026-04-10", to: "2026-04-10" })
        .partsCents,
    ).toBe(STOCK_DOLLARS * 100);
  });
});

describe("a work order's ledger and its job cards", () => {
  // Why a work order save needs no ledger write: archiving keeps the card's
  // work order, and requests on it count the same live or archived.
  it("is the same whether the job card a request names is live or archived", () => {
    const { s, order } = fixture();
    const live = {
      ...s,
      taskCards: s.archivedTaskCards,
      archivedTaskCards: [],
    };
    expect(workOrderLedger(live, order)).toEqual(workOrderLedger(s, order));
    expect(
      workOrderLedger({ ...s, archivedTaskCards: [] }, order).map(
        (d) => d.date,
      ),
    ).not.toContain("2026-05-05");
  });
});

describe("the cost report from ledger rows", () => {
  it("lists each work order with a row in the period, oldest opened first, with its totals and the period's", () => {
    const row = (workOrderUuid: string, date: string, laborCents: number) => ({
      workOrderUuid,
      date,
      laborSeconds: 60,
      laborCents,
      partsCents: 0,
      otherCents: 5,
    });
    const rows: LedgerRow[] = [
      row("late", "2026-02-01", 100),
      row("early", "2026-02-02", 200),
      row("early", "2026-03-01", 300),
      row("gone", "2026-02-03", 400),
      row("late", "2025-12-31", 999),
    ];
    const orders = [
      {
        uuid: "late",
        number: "WO-2",
        status: "open",
        dateOpened: "2026-01-20",
      },
      {
        uuid: "early",
        number: "WO-1",
        status: "completed",
        dateOpened: "2026-01-05",
      },
    ] as const;
    const report = ledgerCostReport(rows, orders, {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(
      report.orders.map((o) => [o.number, o.dateOpened, o.totalCents]),
    ).toEqual([
      ["", "", 405],
      ["WO-1", "2026-01-05", 510],
      ["WO-2", "2026-01-20", 105],
    ]);
    expect(report.totalCents).toBe(1020);
    expect(report.laborSeconds).toBe(240);
  });
});

// Every month, quarter and dated day of 2026, and the year.
function periods(dates: string[]): Period[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const months = Array.from({ length: MONTHS }, (_, i) => ({
    from: `2026-${pad(i + 1)}-01`,
    to: `2026-${pad(i + 1)}-31`,
  }));
  const quarters = [1, 4, 7, 10].map((m) => ({
    from: `2026-${pad(m)}-01`,
    to: `2026-${pad(m + 2)}-31`,
  }));
  const days = dates.map((d) => ({ from: d, to: d }));
  return [
    ...months,
    ...quarters,
    ...days,
    { from: "2026-01-01", to: "2026-12-31" },
  ];
}

// One work order with labor on two dates, another cost, a part issued at a
// recorded price, one issued before prices were recorded, and parts on an
// archived job card priced by a manual unit cost.
function fixture() {
  const base = demoSnapshot();
  const aircraft = base.aircraft[0];
  const order: WorkOrder = workOrderSchema.parse({
    uuid: "00000000-0000-4000-8000-00000000c001",
    version: 1,
    number: "WO-2026-0001",
    aircraftUuid: aircraft.uuid,
    dateOpened: "2026-03-01",
    supervisor: "Chief inspector",
    scope: "Annual",
    priority: "routine",
    status: "open",
    completionDate: "",
    releaseOutcome: "",
    finalReview: "",
    recordedAt: 0,
    createdBy: "admin",
    aircraft: {
      registration: aircraft.registration,
      make: aircraft.make,
      model: aircraft.model,
      serial: aircraft.serial,
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      meter: "hobbs",
      cycles: 0,
    },
    componentReadings: [],
    tasks: [],
  });
  const card = taskCardSchema.parse({
    ...taskCardDefaults(aircraft.uuid),
    uuid: "00000000-0000-4000-8000-00000000c002",
    version: 1,
    cardNumber: "JC-1",
    title: "Brakes",
    workOrderUuid: order.uuid,
    createdAt: 0,
    updatedAt: 0,
    createdBy: "admin",
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  });
  const onTask = request(
    "00000000-0000-4000-8000-00000000c003",
    {
      kind: "workTask",
      uuid: "task-1",
      workOrderUuid: order.uuid,
    },
    [
      issue("stock-1", 2, "2026-03-02", 1),
      issue("stock-1", 1, "2026-04-10", 2),
    ],
  );
  const onCard = request(
    "00000000-0000-4000-8000-00000000c004",
    {
      kind: "jobCard",
      uuid: card.uuid,
      workOrderUuid: "",
    },
    [issue("stock-2", 3, "2026-05-05", 3)],
  );
  const record = costRecordSchema.parse({
    uuid: "00000000-0000-4000-8000-00000000c005",
    version: 3,
    programUuid: PROGRAM,
    kind: "workOrder",
    aircraftUuid: aircraft.uuid,
    workOrderUuid: order.uuid,
    labor: [
      labor("00000000-0000-4000-8000-00000000c006", "2026-03-02", 60),
      labor("00000000-0000-4000-8000-00000000c007", "2026-06-01", 95),
    ],
    other: [
      {
        uuid: "00000000-0000-4000-8000-00000000c008",
        date: "2026-04-10",
        description: "Freight",
        amountCents: 2500,
        createdBy: "admin",
        createdAt: 0,
      },
    ],
    partUnitCosts: [{ stockUuid: "stock-2", unitCents: MANUAL_CENTS }],
    issuedParts: [
      {
        requestUuid: onTask.uuid,
        issuedAt: 1,
        stockUuid: "stock-1",
        quantity: 2,
        date: "2026-03-02",
        unitCents: RECORDED_CENTS,
      },
      {
        requestUuid: onCard.uuid,
        issuedAt: 3,
        stockUuid: "stock-2",
        quantity: 3,
        date: "2026-05-05",
        unitCents: 800,
      },
    ],
  });
  const s: Snapshot = {
    ...base,
    workOrders: [order],
    taskCards: [],
    archivedTaskCards: [card],
    partsRequests: [onTask, onCard],
    costs: [record],
    management: [stock("stock-1", STOCK_DOLLARS), stock("stock-2", 7.5)],
  };
  return { s, order };
}

function request(
  uuid: string,
  source: { kind: string; uuid: string; workOrderUuid: string },
  issues: ReturnType<typeof issue>[],
) {
  return partsRequestSchema.parse({
    ...requestDraftSchema.parse({
      uuid,
      version: 1,
      source,
      mode: "parts",
      date: "2026-03-01",
      engineer: "Mechanic",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [
        { uuid: "line-1", partNumber: "P-1", description: "Pad", quantity: 9 },
      ],
    }),
    programUuid: PROGRAM,
    aircraftUuid: demoSnapshot().aircraft[0].uuid,
    sourceLabel: "Work order",
    aircraftRegistration: "",
    aircraftSerial: "",
    aircraftModel: "",
    number: `PR-${uuid.slice(-4)}`,
    requesterId: "admin",
    createdAt: 0,
    updatedAt: 0,
    cancelled: false,
    reservations: [],
    issues,
    history: [],
  });
}

function issue(stockUuid: string, quantity: number, date: string, at: number) {
  return {
    lineUuid: "line-1",
    stockUuid,
    quantity,
    at,
    actorId: "admin",
    date,
  };
}

function labor(uuid: string, date: string, minutes: number) {
  return {
    uuid,
    date,
    technician: "Mechanic",
    minutes,
    seconds: minutes * 60,
    rateCents: RATE_CENTS,
    createdBy: "admin",
    createdAt: 0,
  };
}

function stock(uuid: string, cost: number) {
  return recordSchema.parse({
    uuid,
    version: 1,
    programUuid: PROGRAM,
    kind: "stock",
    locationUuid: "store",
    partNumber: uuid.toUpperCase(),
    alternates: "",
    description: "Part",
    category: "part",
    condition: "new",
    quantity: 10,
    minimum: 0,
    vendor: "",
    cost,
  });
}
