/**
 * Responsibility: Pins the chart data of the shop screens: work orders by
 *   status, costs by month and stock lots by reorder state.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/shopCharts.ts, ./costs, ./workOrders,
 *   src/data/demo.ts, tests/fixtures/workOrders.ts.
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { saveWorkOrder } from "./workOrders";
import { aircraftCostReport, applyCostCommand } from "./costs";
import { monthlyCosts, stockLevels, workOrderStatusCounts } from "./shopCharts";

const NOW = Date.parse("2026-06-15T12:00:00");
const YEAR = { from: "2026-01-01", to: "2026-12-31" };

function costedOrder() {
  const s = demoSnapshot();
  const order = saveWorkOrder(s, workOrderCommand(), NOW);
  const labor = (date: string, seconds: number) =>
    applyCostCommand(
      s,
      {
        action: "labor.add",
        workOrderUuid: order.uuid,
        entry: {
          uuid: crypto.randomUUID(),
          date,
          technician: "Sam",
          seconds,
          rateCents: 10000,
        },
      },
      NOW,
    );
  labor("2026-03-31", 3600);
  labor("2026-04-01", 1800);
  applyCostCommand(
    s,
    {
      action: "other.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: "2026-04-30",
        description: "Hangar fee",
        amountCents: 2500,
      },
    },
    NOW,
  );
  return { s, order };
}

describe("workOrderStatusCounts", () => {
  it("counts each status in the order of workOrderStatuses and leaves out empty ones", () => {
    const orders = (["completed", "open", "parts-delay", "open"] as const).map(
      (status) => ({ status }),
    );
    expect(workOrderStatusCounts(orders)).toEqual([
      { status: "open", count: 2 },
      { status: "parts-delay", count: 1 },
      { status: "completed", count: 1 },
    ]);
    expect(workOrderStatusCounts([])).toEqual([]);
  });
});

describe("monthlyCosts", () => {
  it("puts each cost in the month of its date, oldest month first", () => {
    const { s, order } = costedOrder();
    const report = aircraftCostReport(s, order.aircraftUuid, YEAR);
    const months = monthlyCosts(s, report);
    expect(months.map((m) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
    expect(months[2]).toEqual({
      month: "2026-03",
      laborCents: 10000,
      partsCents: 0,
      otherCents: 0,
    });
    expect(months[3]).toEqual({
      month: "2026-04",
      laborCents: 5000,
      partsCents: 0,
      otherCents: 2500,
    });
  });

  it("adds up to the report's totals and stays inside the period", () => {
    const { s, order } = costedOrder();
    // The period starts after the March entry and ends before the fee.
    const period = { from: "2026-04-01", to: "2026-04-29" };
    const report = aircraftCostReport(s, order.aircraftUuid, period);
    const months = monthlyCosts(s, report);
    expect(months).toEqual([
      { month: "2026-04", laborCents: 5000, partsCents: 0, otherCents: 0 },
    ]);
    expect(months[0].laborCents).toBe(report.laborCents);
    expect(months[0].otherCents).toBe(report.otherCents);
  });

  it("crosses a year end and gives nothing for more than 24 months", () => {
    const { s, order } = costedOrder();
    const report = (from: string, to: string) =>
      aircraftCostReport(s, order.aircraftUuid, { from, to });
    expect(
      monthlyCosts(s, report("2025-11-15", "2026-02-01")).map((m) => m.month),
    ).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthlyCosts(s, report("2025-01-01", "2026-12-31"))).toHaveLength(
      24,
    );
    expect(monthlyCosts(s, report("2024-12-31", "2026-12-31"))).toEqual([]);
  });
});

describe("stockLevels", () => {
  it("counts a lot at its minimum as one to reorder", () => {
    expect(
      stockLevels([
        { quantity: 5, minimum: 2 },
        { quantity: 2, minimum: 2 },
        { quantity: 0, minimum: 1 },
      ]),
    ).toEqual({ inStock: 1, reorder: 2 });
    expect(stockLevels([])).toEqual({ inStock: 0, reorder: 0 });
  });
});
