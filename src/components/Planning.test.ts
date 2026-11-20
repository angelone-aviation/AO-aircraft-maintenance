/**
 * Responsibility: Pins the status tones, the CSV's status words and which
 *   forecast items the Planning screen lists. Filters, printing and the
 *   download need a browser.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Planning.tsx, src/data/demo.ts (demoSnapshot),
 *   src/domain/forecast.ts (ForecastItem, mocked forecast), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { addDays, type ForecastItem } from "../domain/forecast";
import { localDate } from "../domain/model";
import { forecastCsvRows, Planning, statusTone } from "./Planning";

const snapshot = demoSnapshot();
const workspace = { snapshot };
let items: ForecastItem[] = [];
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
vi.mock("../domain/forecast", async (original) => ({
  ...(await original<typeof import("../domain/forecast")>()),
  forecast: () => items,
}));

const item = (title: string, extra: Partial<ForecastItem> = {}) =>
  ({
    key: title,
    kind: "inspection",
    aircraftUuid: "demo-206",
    title,
    detail: "",
    status: "scheduled",
    remaining: "",
    note: "",
    ...extra,
  }) as ForecastItem;
const due = (days: number, overdue = false) => ({
  date: addDays(localDate(), days),
  basis: "hours" as const,
  overdue,
});

describe("statusTone", () => {
  it("marks overdue, past due and overdue projections as danger", () => {
    expect(statusTone(item("a", { status: "overdue" }))).toBe("danger");
    expect(statusTone(item("a", { status: "past due" }))).toBe("danger");
    expect(statusTone(item("a", { projection: due(0, true) }))).toBe("danger");
  });

  it("marks due soon and due now as warning, anything else neutral", () => {
    expect(statusTone(item("a", { status: "due-soon" }))).toBe("warning");
    expect(statusTone(item("a", { status: "Due now" }))).toBe("warning");
    expect(statusTone(item("a"))).toBe("neutral");
  });
});

describe("forecastCsvRows", () => {
  it("exports the status words the screen shows, not status codes", () => {
    const status = (extra: Partial<ForecastItem>) =>
      forecastCsvRows([item("a", extra)], () => "N206MA")[0].Status;
    expect(status({ status: "due-soon" })).toBe("Due soon");
    expect(status({ status: "Due now" })).toBe("Due now");
    expect(status({ status: "unknown", projection: due(0, true) })).toBe(
      "Overdue",
    );
  });
});

describe("Planning", () => {
  const render = () => renderToStaticMarkup(createElement(Planning));

  it("lists items due within 30 days, then those it cannot project", () => {
    items = [
      item("Soon", { projection: due(10) }),
      item("Later", { projection: due(45) }),
      item("Unknown"),
    ];
    const html = render();
    expect(html).toContain("Soon");
    expect(html).not.toContain("Later");
    expect(html.indexOf("Insufficient data")).toBeLessThan(
      html.indexOf("Unknown"),
    );
  });

  it("hides aircraft the user may not read", () => {
    items = [item("Elsewhere", { aircraftUuid: "demo-208" })];
    workspace.snapshot = {
      ...snapshot,
      user: { ...snapshot.user, isAdmin: false, groupIds: ["one"] },
      groups: [{ ...snapshot.groups[0], id: "one", aircraftIds: ["demo-206"] }],
    };
    expect(render()).not.toContain("Elsewhere");
    workspace.snapshot = snapshot;
    expect(render()).toContain("Elsewhere");
  });
});
