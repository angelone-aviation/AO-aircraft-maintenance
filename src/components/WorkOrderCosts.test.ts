/**
 * Responsibility: Pins who sees which parts of a work order's costs panel and
 *   when it offers changes. Adding and removing need a browser.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrderCosts.tsx, src/data/demo.ts
 *   (demoSnapshot), src/domain/costs.ts (mocked totals), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import type { WorkOrder } from "../domain/workOrders";
import { WorkOrderCosts } from "./WorkOrderCosts";

const base = demoSnapshot();
const workspace = { snapshot: base as Snapshot, online: true, connected: true };
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace, { getState: () => workspace }),
}));
const labor = (uuid: string, technician: string, createdBy: string) => ({
  uuid,
  date: "2026-11-01",
  technician,
  seconds: 3600,
  createdBy,
});
vi.mock("../domain/costs", async (original) => ({
  ...(await original<typeof import("../domain/costs")>()),
  workOrderCosts: () => ({
    labor: [labor("a", "Mine", base.user.id), labor("b", "Theirs", "other")],
    parts: [],
    other: [],
    laborCents: 0,
    partsCents: 0,
    otherCents: 0,
    totalCents: 0,
    laborSeconds: 7200,
  }),
}));

const maintainer = {
  ...base,
  user: { ...base.user, isAdmin: false, groupIds: ["maint"] },
  groups: [
    { ...base.groups[0], id: "maint", permissions: ["read", "maintenance"] },
  ],
} as Snapshot;
const pilot = {
  ...base,
  user: { ...base.user, isAdmin: false, groupIds: ["demo-pilots"] },
} as Snapshot;
const order = (status: string) =>
  ({ uuid: "wo", aircraftUuid: "demo-206", status }) as WorkOrder;
const render = (snapshot: Snapshot, status = "open") => {
  workspace.snapshot = snapshot;
  return renderToStaticMarkup(
    createElement(WorkOrderCosts, { order: order(status) }),
  );
};

describe("WorkOrderCosts", () => {
  it("shows administrators amounts, parts and other costs", () => {
    const html = render(base);
    for (const text of [
      "Total",
      "<th>Rate</th>",
      "Parts issued",
      "Other costs",
    ])
      expect(html).toContain(text);
  });

  it("shows maintainers labor only", () => {
    const html = render(maintainer);
    expect(html).toContain("Add labor");
    for (const text of [
      "Total",
      "<th>Rate</th>",
      "Parts issued",
      "Other costs",
    ])
      expect(html).not.toContain(text);
  });

  it("lets a maintainer remove only labor they recorded", () => {
    const html = render(maintainer);
    expect(html).toContain("Remove labor for Mine");
    expect(html).not.toContain("Remove labor for Theirs");
  });

  it("offers no changes on a closed order or without a connection", () => {
    expect(render(base, "completed")).not.toContain("Add labor");
    workspace.connected = false;
    expect(render(base)).not.toContain("Add labor");
    workspace.connected = true;
  });

  it("renders nothing for a user without maintenance permission", () => {
    expect(render(pilot)).toBe("");
  });
});
