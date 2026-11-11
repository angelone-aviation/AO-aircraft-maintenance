/**
 * Responsibility: Pins the work order cards and the status chart: what each
 *   card says about progress, status and tasks, and the chart's parts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrderList.tsx, react-dom/server,
 *   src/domain/workOrders.ts, src/data/demo.ts, tests/fixtures/workOrders.ts.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  newWorkTask,
  saveWorkOrder,
  type WorkOrder,
} from "../domain/workOrders";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import {
  WorkOrderCards,
  WorkOrderStatusChart,
  WorkOrderStatusPill,
} from "./WorkOrderList";

const s = demoSnapshot();

function order(tasks: string[], patch: Partial<WorkOrder> = {}): WorkOrder {
  const command = workOrderCommand();
  command.tasks = tasks.map((description) =>
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, description),
  );
  return Object.assign(saveWorkOrder(s, command), patch);
}

const text = (html: string) =>
  html.replace(/<svg.*?<\/svg>/g, "").replace(/<[^>]+>/g, "|");

describe("WorkOrderCards", () => {
  it("counts finished tasks and lists each task with its status", () => {
    const w = order(["Drain oil", "Fit filter"], { status: "in-progress" });
    w.tasks[0].status = "completed";
    w.tasks[1].status = "parts-delay";
    w.tasks[1].partsDelay = "Filter on back order";
    const html = renderToStaticMarkup(
      h(WorkOrderCards, { s, list: [w], onSelect: vi.fn() }),
    );
    expect(text(html)).toContain("|1 of 2 tasks|");
    expect(text(html)).toContain("|In progress|");
    expect(html).toContain('<li class="done">');
    expect(text(html)).toContain("|Drain oil||Completed|");
    expect(text(html)).toContain(
      "|Fit filter||Parts delay: Filter on back order|",
    );
    // One parts delay, from the task; no discrepancy is on the order.
    expect(html).toContain(
      '<td data-label="Parts delays"><span class="shop-count-warn">1</span>',
    );
    expect(html).toContain(
      '<td data-label="Open discrepancies"><span class="shop-zero">0</span>',
    );
  });

  it("says one task in the singular and leaves out an empty task list", () => {
    const one = renderToStaticMarkup(
      h(WorkOrderCards, { s, list: [order(["Only"])], onSelect: vi.fn() }),
    );
    expect(text(one)).toContain("|0 of 1 task|");
    const none = renderToStaticMarkup(
      h(WorkOrderCards, { s, list: [order([])], onSelect: vi.fn() }),
    );
    expect(text(none)).toContain("|0 of 0 tasks|");
    expect(none).toContain('<td class="shop-order-tasks"></td>');
  });

  it("gives each order one row with a Details button", () => {
    const html = renderToStaticMarkup(
      h(WorkOrderCards, {
        s,
        list: [order([]), order([])],
        onSelect: vi.fn(),
      }),
    );
    expect(html.match(/<tr /g)).toHaveLength(2);
    expect(
      html.match(/<button class="button small">Details<\/button>/g),
    ).toHaveLength(2);
  });
});

describe("WorkOrderStatusPill", () => {
  it("words the status and takes amber only for an order that waits", () => {
    const pill = (status: WorkOrder["status"]) =>
      renderToStaticMarkup(h(WorkOrderStatusPill, { status }));
    expect(pill("parts-delay")).toMatch(
      /^<span class="ds-pill ds-tone-warn"><svg.*<\/svg>Parts delay<\/span>$/,
    );
    expect(pill("awaiting-approval")).toContain("ds-tone-warn");
    expect(pill("in-progress")).toContain("ds-tone-blue");
    expect(pill("completed")).toContain("ds-tone-good");
    expect(pill("open")).toContain("ds-tone-neutral");
    expect(pill("cancelled")).toContain("ds-tone-neutral");
  });
});

describe("WorkOrderStatusChart", () => {
  it("names the figure and lists each status with its count and share", () => {
    const orders = [
      order([], { status: "completed" }),
      order([]),
      order([]),
      order([], { status: "parts-delay" }),
    ];
    const html = renderToStaticMarkup(h(WorkOrderStatusChart, { orders }));
    expect(html).toContain('aria-label="Work orders by status"');
    expect(text(html)).toContain("4 work orders, closed ones included");
    expect(text(html)).toMatch(/Open\|+2\|+50%/);
    expect(text(html)).toMatch(/Parts delay\|+1\|+25%/);
    expect(text(html)).toMatch(/Completed\|+1\|+25%/);
    expect(text(html)).not.toContain("Cancelled");
  });

  it("renders nothing without work orders", () => {
    expect(renderToStaticMarkup(h(WorkOrderStatusChart, { orders: [] }))).toBe(
      "",
    );
  });
});
