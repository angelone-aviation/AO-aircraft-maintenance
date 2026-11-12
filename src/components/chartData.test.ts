/**
 * Responsibility: Pins the chart data helpers: colour cycling, the text
 *   table, shares of a whole, the meter's clamp and the sparkline reading.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/chartData.ts.
 */
// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  chartColor,
  chartTable,
  drawnSlices,
  meterPercent,
  plotRows,
  shares,
  trendSummary,
  type ChartRow,
  type ChartSeries,
} from "./chartData";

const SERIES: ChartSeries[] = [
  { key: "hours", label: "Flight hours" },
  { key: "landings", label: "Landings" },
];
const ROWS: ChartRow[] = [
  { label: "Sep", values: { hours: 12.5, landings: 9 } },
  { label: "Oct", values: { hours: 8 } },
  { label: "Nov", values: { hours: Number.NaN, landings: 4 } },
];
const oneDecimal = (n: number) => n.toFixed(1);

describe("chartColor", () => {
  it("uses a tone when given and otherwise cycles the five-colour palette", () => {
    expect(chartColor("2", 0)).toBe("var(--chart-2)");
    expect(chartColor(undefined, 0)).toBe("var(--chart-1)");
    expect(chartColor(undefined, 4)).toBe("var(--chart-5)");
    expect(chartColor(undefined, 5)).toBe("var(--chart-1)");
  });

  // The status text colours are too dark to fill a ring or a bar.
  it("fills status data with the chart status tokens, not the text ones", () => {
    expect(chartColor("slate", 0)).toBe("var(--chart-slate)");
    expect(chartColor("good", 0)).toBe("var(--chart-good)");
    expect(chartColor("warn", 0)).toBe("var(--chart-warn)");
    expect(chartColor("danger", 0)).toBe("var(--chart-danger)");
  });
});

describe("drawnSlices", () => {
  it("drops parts of zero or less, keeping each part's colour by position", () => {
    expect(
      drawnSlices([
        { label: "Overdue", value: 0, tone: "danger" },
        { label: "Labor", value: 2 },
        { label: "Lost", value: -1 },
        { label: "Parts", value: Number.NaN },
        { label: "Other", value: 3 },
      ]),
    ).toEqual([
      { label: "Labor", value: 2, color: "var(--chart-2)" },
      { label: "Other", value: 3, color: "var(--chart-5)" },
    ]);
  });
});

describe("chartTable", () => {
  it("lists rows in order with formatted values, reading a gap as 0", () => {
    expect(chartTable(ROWS, SERIES, oneDecimal, "Month")).toEqual({
      head: ["Month", "Flight hours", "Landings"],
      body: [
        ["Sep", "12.5", "9.0"],
        ["Oct", "8.0", "0.0"],
        ["Nov", "0.0", "4.0"],
      ],
    });
  });
});

describe("plotRows", () => {
  it("flattens each row to its label and one number per series", () => {
    expect(plotRows(ROWS, SERIES)).toEqual([
      { label: "Sep", hours: 12.5, landings: 9 },
      { label: "Oct", hours: 8, landings: 0 },
      { label: "Nov", hours: 0, landings: 4 },
    ]);
  });
});

describe("shares", () => {
  it("gives each value's percent of the total to one decimal, in order", () => {
    expect(shares([3, 1])).toEqual([75, 25]);
    expect(shares([1, 1, 1])).toEqual([33.3, 33.3, 33.3]);
  });

  it("counts negative and non-finite values as nothing", () => {
    expect(shares([2, -5, Number.NaN, 2])).toEqual([50, 0, 0, 50]);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(shares([])).toEqual([]);
  });
});

describe("meterPercent", () => {
  it("clamps to 0–100 and rounds to a whole percent", () => {
    expect(meterPercent(8.8, 100)).toBe(9);
    expect(meterPercent(150, 100)).toBe(100);
    expect(meterPercent(-3, 100)).toBe(0);
  });

  it("is 0 without a usable maximum or value", () => {
    expect(meterPercent(5, 0)).toBe(0);
    expect(meterPercent(Number.NaN, 10)).toBe(0);
    expect(meterPercent(5, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("trendSummary", () => {
  it("reads the latest, lowest and highest points", () => {
    expect(trendSummary([2, 6.25, 4], oneDecimal)).toBe(
      "Latest 4.0; low 2.0, high 6.3 over 3 points.",
    );
  });

  it("says when there is nothing to read", () => {
    expect(trendSummary([], oneDecimal)).toBe("No data.");
  });
});
