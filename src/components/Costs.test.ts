/**
 * Responsibility: Pins who sees the cost screens, that they show the cost
 *   ledger's report (history.costReport), the budget bar's states and the
 *   cost summary's figures.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Costs.tsx, react-dom/server, src/data/demo.ts
 *   (seed), src/domain (costs, costs/costReport, model).
 */
// @vitest-environment node
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { CostRecord } from "../domain/costs";
import type { CostReportView } from "../domain/costs/costReport";
import { localDate, type Snapshot } from "../domain/model";
import { AircraftCostSummary, BudgetBar, CostsPage } from "./Costs";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace.state, {
    getState: () => workspace.state,
  }),
}));
const ledger = vi.hoisted(() => ({
  loaded: {} as Record<string, unknown>,
  asked: [] as unknown[][],
}));
vi.mock("../data/costReports", () => ({
  useCostReport: (...args: unknown[]) => {
    ledger.asked.push(args);
    return ledger.loaded;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; children: ReactNode }) =>
    h("a", { href: props.to }, props.children),
}));

const YEAR = Number(localDate().slice(0, 4));
let s: Snapshot;

beforeEach(() => {
  s = demoSnapshot();
  workspace.state = { snapshot: s, online: true, connected: true };
  ledger.asked = [];
  ledger.loaded = { report: report(), loading: false, error: "" };
});

// A ledger report of one work order with $120 of labor in the year.
function report(): CostReportView {
  const line = {
    workOrderUuid: "wo",
    number: "WO-LEDGER-1",
    status: "completed",
    dateOpened: `${YEAR}-02-01`,
    laborSeconds: 5400,
    laborCents: 12_000,
    partsCents: 0,
    otherCents: 0,
    totalCents: 12_000,
  };
  return {
    period: { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` },
    orders: [line],
    months: [],
    laborSeconds: 5400,
    laborCents: 12_000,
    partsCents: 0,
    otherCents: 0,
    totalCents: 12_000,
    budgets: [],
    flightSeconds: 7200,
    costPerHourCents: 6000,
  };
}

const nonAdministrator = () => {
  s.user = { ...s.user, isAdmin: false, groupIds: [] };
};

function budget(amountCents: number): CostRecord {
  const aircraftUuid = s.aircraft[0].uuid;
  return {
    uuid: "b",
    version: 1,
    programUuid: "p",
    kind: "budget",
    aircraftUuid,
    year: YEAR,
    amountCents,
  };
}

function bar(budgetCents: number | undefined, actualCents: number | undefined) {
  return renderToStaticMarkup(
    h(BudgetBar, { year: YEAR, budgetCents, actualCents }),
  );
}

describe("CostsPage", () => {
  it("renders nothing before the snapshot loads", () => {
    workspace.state = { snapshot: null };
    expect(renderToStaticMarkup(h(CostsPage))).toBe("");
  });

  it("shows administrators the ledger's report for this year with an export", () => {
    const html = renderToStaticMarkup(h(CostsPage));
    expect(ledger.asked[0]).toEqual([
      s.aircraft[0],
      { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` },
    ]);
    expect(html).toContain("Export CSV");
    expect(html).toContain(`Work orders · ${YEAR}-01-01 to ${YEAR}-12-31`);
    expect(html).toContain("WO-LEDGER-1");
    expect(html).toContain("$120.00");
    expect(html).toContain("$60.00 per flight hour");
    expect(html).toContain("Annual budget");
  });

  it("needs a connection for the report, and says so", () => {
    ledger.loaded = { loading: false, error: "", offline: true };
    const html = renderToStaticMarkup(h(CostsPage));
    expect(html).toContain("The cost report needs a connection.");
    expect(html).not.toContain("Export CSV");
  });

  it("shows the server's refusal as an alert", () => {
    ledger.loaded = { loading: false, error: "History not found." };
    expect(renderToStaticMarkup(h(CostsPage))).toMatch(
      /role="alert"[^>]*>.*History not found\./,
    );
  });

  it("tells anyone else that costs are for administrators", () => {
    nonAdministrator();
    const html = renderToStaticMarkup(h(CostsPage));
    expect(html).toContain("Administrator access required");
    expect(html).not.toContain("Export CSV");
  });
});

describe("BudgetBar", () => {
  it("reports the actual spend when no budget is set", () => {
    expect(bar(undefined, 0)).toBe(
      `<p class="muted">No ${YEAR} budget set. Actual spend $0.00.</p>`,
    );
  });

  it("waits for the ledger's spend before measuring it", () => {
    expect(bar(50_000, undefined)).toBe(
      `<p class="muted">The ${YEAR} spend loads from the cost ledger while connected.</p>`,
    );
  });

  it("shows the amount remaining under budget, and over it", () => {
    expect(bar(50_000, 60_000)).toContain("Over budget by $100.00");
    const html = bar(50_000, 0);
    expect(html).toContain("<strong>$0.00</strong> of $500.00 (0%)");
    expect(html).toContain("$500.00 remaining");
    expect(html).not.toContain(" over");
  });

  it("treats a zero budget as fully remaining, with an empty bar", () => {
    const html = bar(0, 0);
    expect(html).toContain("of $0.00 (0%)");
    expect(html).toContain("$0.00 remaining");
    expect(html).toContain('aria-valuenow="0"');
  });
});

describe("AircraftCostSummary", () => {
  const summary = () =>
    renderToStaticMarkup(
      h(AircraftCostSummary, { aircraftUuid: s.aircraft[0].uuid }),
    );

  it("shows this year's ledger totals and the budget to administrators", () => {
    s.costs = [budget(50_000)];
    const html = summary();
    expect(html).toContain(`${YEAR} maintenance costs`);
    expect(html).toContain("<dt>Per flight hour</dt><dd>$60.00</dd>");
    expect(html).toContain("<strong>$120.00</strong> of $500.00 (24%)");
  });

  it("renders nothing for anyone else", () => {
    nonAdministrator();
    expect(summary()).toBe("");
  });
});
