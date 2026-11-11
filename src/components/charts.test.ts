/**
 * Responsibility: Pins what the shared charts render without their plot: the
 *   named figure, the hidden data table, legends, and the meter and stacked
 *   bar's markup.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/charts.tsx, react-dom/server.
 *
 * Server rendering leaves each lazy plot at its loading placeholder, which
 * is the state a reader meets before the plot chunk arrives; the drawn plot
 * needs a browser.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BarChart,
  Donut,
  LineChart,
  Meter,
  Sparkline,
  StackedBar,
  type AxisChartProps,
} from "./charts";

// React marks each Suspense boundary with comments and a <template> saying
// the plot renders in the browser; neither is content.
const html = (element: ReactElement) =>
  renderToString(element).replace(
    /<!--.*?-->|<template[\s\S]*?<\/template>/g,
    "",
  );
const hours = (n: number) => `${n.toFixed(1)} h`;
const CHART: AxisChartProps = {
  label: "Hours flown by month",
  categoryLabel: "Month",
  format: hours,
  series: [
    { key: "day", label: "Day" },
    { key: "night", label: "Night", tone: "5" },
  ],
  rows: [
    { label: "Oct", values: { day: 12, night: 2.5 } },
    { label: "Nov", values: { day: 9 } },
  ],
};
const TABLE =
  '<table class="sr-only"><caption class="sr-only">Hours flown by month</caption>' +
  '<thead><tr><th scope="col">Month</th><th scope="col">Day</th>' +
  '<th scope="col">Night</th></tr></thead><tbody>' +
  '<tr><th scope="row">Oct</th><td>12.0 h</td><td>2.5 h</td></tr>' +
  '<tr><th scope="row">Nov</th><td>9.0 h</td><td>0.0 h</td></tr>' +
  "</tbody></table>";

describe("axis charts", () => {
  it("name the figure and carry the data as a hidden table", () => {
    for (const chart of [BarChart, LineChart]) {
      const page = html(h(chart, CHART));
      expect(page).toContain(
        '<figure class="ds-chart" aria-label="Hours flown by month">',
      );
      expect(page).toContain(TABLE);
    }
  });

  it("hide the plot from screen readers and reserve its height", () => {
    expect(html(h(BarChart, { ...CHART, height: 180 }))).toContain(
      '<div class="ds-chart-plot" style="height:180px" aria-hidden="true">' +
        '<span class="ds-chart-loading"></span></div>',
    );
  });

  it("show a legend only when there is more than one series", () => {
    expect(html(h(BarChart, CHART))).toContain(
      '<li><i class="ds-chart-swatch" style="--swatch:var(--chart-5)"' +
        ' aria-hidden="true"></i>Night</li>',
    );
    const single = { ...CHART, series: CHART.series.slice(0, 1) };
    expect(html(h(BarChart, single))).not.toContain("ds-chart-legend");
  });

  it("can be left off phones", () => {
    expect(html(h(LineChart, { ...CHART, hideOnPhone: true }))).toContain(
      'class="ds-chart hide-phone"',
    );
  });
});

describe("Sparkline", () => {
  it("is an image named with a reading of its trend", () => {
    const spark = h(Sparkline, {
      label: "Hours flown, last 3 weeks",
      values: [2, 6, 4],
      format: hours,
    });
    expect(html(spark)).toBe(
      '<span class="ds-spark" style="height:36px" role="img" aria-label="Hours' +
        ' flown, last 3 weeks. Latest 4.0 h; low 2.0 h, high 6.0 h over 3 points."></span>',
    );
  });
});

const PARTS = [
  { label: "Airworthy", value: 3, tone: "good" as const },
  { label: "Grounded", value: 1, tone: "danger" as const },
];

describe("Donut", () => {
  it("lists every slice with its value and share beside the ring", () => {
    const page = html(h(Donut, { label: "Fleet status", slices: PARTS }));
    expect(page).toContain('aria-label="Fleet status"');
    expect(page).toContain("<span>Airworthy</span><b>3</b><small>75%</small>");
    expect(page).toContain("<span>Grounded</span><b>1</b><small>25%</small>");
  });
});

describe("StackedBar", () => {
  it("sizes each segment by its share, in order, over the same legend", () => {
    const page = html(
      h(StackedBar, { label: "Fleet status", segments: PARTS }),
    );
    expect(page).toContain(
      '<div class="ds-stack-bar" aria-hidden="true">' +
        '<i style="width:75%;background:var(--good)"></i>' +
        '<i style="width:25%;background:var(--danger)"></i></div>',
    );
    expect(page).toContain("<span>Grounded</span><b>1</b><small>25%</small>");
  });
});

describe("Meter", () => {
  it("is a named meter whose value reads as the screen words it", () => {
    const meter = h(Meter, {
      label: "100-hour inspection",
      value: 8.8,
      max: 100,
      valueText: "8.8 h remaining",
      tone: "warn",
      note: "Due at 2,350.0 h",
    });
    expect(html(meter)).toBe(
      '<div class="ds-meter ds-meter-warn"><div class="ds-meter-head">' +
        "<span>100-hour inspection</span><b>8.8 h remaining</b></div>" +
        '<div class="ds-meter-track" role="meter" aria-label="100-hour inspection"' +
        ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="9"' +
        ' aria-valuetext="8.8 h remaining"><i style="width:9%"></i></div>' +
        "<small>Due at 2,350.0 h</small></div>",
    );
  });
});
