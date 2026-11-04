/**
 * Responsibility: Pins what the preflight maintenance summary lists, in what
 *   order, and when it shows its count tiles and all-clear note.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/PreflightMaintenance.tsx, src/data/demo.ts
 *   (demoSnapshot), src/domain/model.ts, src/domain/workOrders.ts (types),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { totalSeconds, type Aircraft, type Snapshot } from "../domain/model";
import type { WorkOrder } from "../domain/workOrders";
import { PreflightMaintenance } from "./PreflightMaintenance";

const summary = (aircraft: Aircraft, snapshot: Snapshot) =>
  renderToStaticMarkup(
    createElement(PreflightMaintenance, { aircraft, snapshot }),
  );

function emptyProgram() {
  const s = demoSnapshot();
  s.discrepancies = [];
  s.workOrders = [];
  s.inspections = [];
  return {
    s,
    a: { ...s.aircraft[0], operationalStatus: "airworthy" as const },
  };
}

it("shows only inspections needing review and excludes archived and other-aircraft data", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.discrepancies = [];
  s.workOrders = [];
  const base = { aircraftUuid: a.uuid, description: "" };
  s.inspections = [
    { ...base, uuid: "due", reference: "OVERDUE", dueDate: "2000-01-01" },
    { ...base, uuid: "missing", reference: "MISSING-DATA" },
    { ...base, uuid: "ok", reference: "NOT-DUE", dueDate: "2099-01-01" },
    { ...base, uuid: "archived", reference: "ARCHIVED", archived: true },
    {
      ...base,
      uuid: "other",
      reference: "OTHER-AIRCRAFT",
      aircraftUuid: "other",
    },
  ];
  const html = renderToStaticMarkup(
    createElement(PreflightMaintenance, { aircraft: a, snapshot: s }),
  );
  expect(html).toContain("OVERDUE");
  expect(html).toContain("MISSING-DATA");
  expect(html).not.toContain("NOT-DUE");
  expect(html).not.toContain("ARCHIVED");
  expect(html).not.toContain("OTHER-AIRCRAFT");
  expect(html).not.toContain("Open discrepancies");
  expect(html).not.toContain("Open work orders");
});

it("distinguishes no review items from missing inspection schedules", () => {
  const s = demoSnapshot();
  const a = { ...s.aircraft[0], operationalStatus: "airworthy" as const };
  s.discrepancies = [];
  s.workOrders = [];
  s.inspections = [
    {
      uuid: "ok",
      aircraftUuid: a.uuid,
      reference: "CURRENT",
      description: "",
      dueDate: "2099-01-01",
    },
  ];
  const render = () =>
    renderToStaticMarkup(
      createElement(PreflightMaintenance, { aircraft: a, snapshot: s }),
    );
  expect(render()).toContain("No due inspections or items needing review");
  expect(render()).not.toContain("CURRENT");
  s.inspections = [];
  expect(render()).toContain("Not recorded");
  expect(render()).not.toContain("No due inspections or items needing review");
});

it("lists overdue, then missing due data, then due soon, by reference", () => {
  const { s, a } = emptyProgram();
  const base = { aircraftUuid: a.uuid, description: "" };
  s.inspections = [
    { ...base, uuid: "1", reference: "A-SOON", dueCycles: a.cycles + 5 },
    { ...base, uuid: "2", reference: "B-UNKNOWN" },
    { ...base, uuid: "3", reference: "C-OVERDUE", dueDate: "2000-01-01" },
    { ...base, uuid: "4", reference: "A-OVERDUE", dueDate: "2000-01-01" },
  ];
  const html = summary(a, s);
  const order = ["A-OVERDUE", "C-OVERDUE", "B-UNKNOWN", "A-SOON"].map((ref) =>
    html.indexOf(`<strong>${ref}</strong>`),
  );
  expect(order).toEqual([...order].sort((x, y) => x - y));
  expect(order).not.toContain(-1);
  expect(html).toContain(
    "Inspections needing review (4) · 2 overdue · 1 due soon · 1 missing due data",
  );
});

it("states each remaining limit, due now at the limit", () => {
  const { s, a } = emptyProgram();
  s.inspections = [
    {
      uuid: "1",
      aircraftUuid: a.uuid,
      reference: "LIMITS",
      description: "",
      dueSeconds: totalSeconds(a) + 3600 * 12.34,
      dueLandings: a.landings,
      dueCycles: a.cycles + 5,
    },
  ];
  const html = summary(a, s);
  expect(html).toContain("<div>12.3 h remaining</div>");
  expect(html).toContain("<span>0 landings overdue / due now</span>");
  expect(html).toContain("<div>5 cycles remaining</div>");
});

it("counts only open discrepancies and open work orders on this aircraft", () => {
  const { s, a } = emptyProgram();
  const discrepancy = demoSnapshot().discrepancies[0];
  s.discrepancies = [
    { ...discrepancy, uuid: "d1", aircraftUuid: a.uuid, status: "open" },
    { ...discrepancy, uuid: "d2", aircraftUuid: a.uuid, status: "resolved" },
    { ...discrepancy, uuid: "d3", aircraftUuid: "other", status: "open" },
  ];
  const tasks: WorkOrder["tasks"] = [];
  const order = (
    number: string,
    status: WorkOrder["status"],
    aircraftUuid = a.uuid,
  ) => ({ uuid: number, number, status, aircraftUuid, tasks }) as WorkOrder;
  s.workOrders = [
    order("WO-OPEN", "open"),
    order("WO-DELAY", "parts-delay"),
    order("WO-DONE", "completed"),
    order("WO-VOID", "cancelled"),
    order("WO-ELSEWHERE", "open", "other"),
  ];
  const html = summary(a, s);
  expect(html).toContain("<span>Open discrepancies</span><strong>1</strong>");
  expect(html).toContain("Open work orders (2)");
  expect(html).toContain("<strong>WO-DELAY</strong> · parts-delay · 0 tasks");
  expect(html).not.toMatch(/WO-DONE|WO-VOID|WO-ELSEWHERE/);
});

it("shows a tile only for what needs review", () => {
  const { s, a } = emptyProgram();
  s.inspections = [
    {
      uuid: "1",
      aircraftUuid: a.uuid,
      reference: "OVERDUE",
      description: "",
      dueDate: "2000-01-01",
    },
  ];
  const html = summary({ ...a, operationalStatus: "grounded" }, s);
  expect(html).toContain(
    '<div class="preflight-metrics"><div class="preflight-metric attention"><span>Aircraft status to review</span><strong>grounded</strong></div><div class="preflight-metric attention"><span>Overdue inspections</span><strong>1</strong></div></div>',
  );
  expect(summary(a, s)).not.toContain("Aircraft status to review");
});
