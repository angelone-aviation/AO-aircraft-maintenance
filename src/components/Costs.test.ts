/**
 * Responsibility: Pins who sees the cost screens, the budget bar's states and
 *   the cost summary's figures.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Costs.tsx, react-dom/server, src/data/demo.ts
 *   (seed).
 */
// @vitest-environment node
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { CostRecord } from "../domain/costs";
import { localDate, type Snapshot } from "../domain/model";
import { AircraftCostSummary, BudgetBar, CostsPage } from "./Costs";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace.state, {
    getState: () => workspace.state,
  }),
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
});

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

function bar(costs: CostRecord[]) {
  s.costs = costs;
  return renderToStaticMarkup(
    h(BudgetBar, { s, aircraftUuid: s.aircraft[0].uuid, year: YEAR }),
  );
}

describe("CostsPage", () => {
  it("renders nothing before the snapshot loads", () => {
    workspace.state = { snapshot: null };
    expect(renderToStaticMarkup(h(CostsPage))).toBe("");
  });

  it("shows administrators this year's report with an export", () => {
    const html = renderToStaticMarkup(h(CostsPage));
    expect(html).toContain("Export CSV");
    expect(html).toContain(`Work orders · ${YEAR}-01-01 to ${YEAR}-12-31`);
    expect(html).toContain("Annual budget");
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
    expect(bar([])).toBe(
      `<p class="muted">No ${YEAR} budget set. Actual spend $0.00.</p>`,
    );
  });

  it("shows the amount remaining under budget", () => {
    const html = bar([budget(50_000)]);
    expect(html).toContain("<strong>$0.00</strong> of $500.00 (0%)");
    expect(html).toContain("$500.00 remaining");
    expect(html).not.toContain(" over");
  });

  it("treats a zero budget as fully remaining, with an empty bar", () => {
    const html = bar([budget(0)]);
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

  it("shows this year's totals and the budget to administrators", () => {
    const html = summary();
    expect(html).toContain(`${YEAR} maintenance costs`);
    expect(html).toContain("<dt>Per flight hour</dt>");
    expect(html).toContain(`No ${YEAR} budget set.`);
  });

  it("renders nothing for anyone else", () => {
    nonAdministrator();
    expect(summary()).toBe("");
  });
});
