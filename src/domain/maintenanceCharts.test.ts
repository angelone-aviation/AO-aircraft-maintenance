/**
 * Responsibility: Pins the chart data of the Inspections and Planning
 *   screens: status counts and the monthly workload.
 * Layer: Test. Vitest unit tests of pure functions.
 * Dependencies: vitest, ./maintenanceCharts, ./forecast (item type).
 */
import { describe, expect, it } from "vitest";
import type { ForecastItem } from "./forecast";
import {
  WORKLOAD_MONTHS,
  inspectionStatusSlices,
  monthlyWorkload,
} from "./maintenanceCharts";

const item = (
  kind: ForecastItem["kind"],
  date?: string,
  overdue = false,
): ForecastItem => ({
  key: `${kind}-${date}`,
  kind,
  title: "Item",
  detail: "",
  status: "scheduled",
  remaining: "",
  note: "",
  projection: date ? { date, basis: "calendar", overdue } : undefined,
});

describe("inspectionStatusSlices", () => {
  it("counts each status, most urgent first; Scheduled takes cobalt", () => {
    expect(
      inspectionStatusSlices(["scheduled", "overdue", "scheduled", "due-soon"]),
    ).toEqual([
      { label: "Overdue", value: 1, tone: "danger" },
      { label: "Due soon", value: 1, tone: "warn" },
      { label: "Scheduled", value: 2, tone: "1" },
    ]);
  });

  it("keeps the three statuses at zero and names Unknown only when present", () => {
    expect(inspectionStatusSlices([]).map((s) => [s.label, s.value])).toEqual([
      ["Overdue", 0],
      ["Due soon", 0],
      ["Scheduled", 0],
    ]);
    expect(inspectionStatusSlices(["unknown"]).at(-1)).toEqual({
      label: "Unknown",
      value: 1,
      tone: "5",
    });
  });
});

describe("monthlyWorkload", () => {
  it("returns twelve months from today's, across the year end", () => {
    const months = monthlyWorkload([], "2026-11-11");
    expect(months).toHaveLength(WORKLOAD_MONTHS);
    expect(months[0]).toEqual({
      month: "2026-11",
      label: "Nov 2026",
      values: { inspection: 0, component: 0, ad: 0 },
    });
    expect(months[2].month).toBe("2027-01");
    expect(months.at(-1)!.label).toBe("Oct 2027");
  });

  it("counts each kind in the month it is projected to fall due", () => {
    const months = monthlyWorkload(
      [
        item("inspection", "2026-12-05"),
        item("inspection", "2026-12-31"),
        item("ad", "2026-12-01"),
        item("component", "2027-02-03"),
      ],
      "2026-11-11",
    );
    expect(months[1].values).toEqual({ inspection: 2, component: 0, ad: 1 });
    expect(months[3].values).toEqual({ inspection: 0, component: 1, ad: 0 });
  });

  it("counts an overdue item in the first month and leaves out undated and later items", () => {
    const months = monthlyWorkload(
      [
        item("inspection", "2026-11-11", true),
        item("component"),
        item("ad", "2027-11-01"),
      ],
      "2026-11-11",
    );
    expect(months[0].values.inspection).toBe(1);
    const total = months.reduce(
      (sum, m) => sum + m.values.inspection + m.values.component + m.values.ad,
      0,
    );
    expect(total).toBe(1);
  });
});
