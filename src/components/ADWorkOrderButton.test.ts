/**
 * Responsibility: Pins which AD actions the work-order button offers, and
 *   when it offers none.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ADWorkOrderButton.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 *
 * The AD status rules are mocked so each case names the statuses it needs;
 * src/domain/airworthiness.test.ts pins the rules themselves.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { AD } from "../domain/airworthiness";
import { ADWorkOrderButton } from "./ADWorkOrderButton";

const ui = vi.hoisted(() => ({
  status: "Scheduled",
  tasks: {} as Record<string, string>,
  added: undefined as Record<string, unknown> | undefined,
}));
vi.mock("../domain/airworthiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domain/airworthiness")>()),
  adStatus: () => ui.status,
  adTaskStatus: (_s: unknown, _r: unknown, task: { uuid: string }) =>
    ui.tasks[task.uuid],
  adAircraftUuid: () => "demo-206",
}));
vi.mock("./WorkOrders", () => ({
  AddToWorkOrder: (props: Record<string, unknown>) => {
    ui.added = props;
    return "[AddToWorkOrder]";
  },
}));

const state = demoSnapshot();
const record = {
  applicability: "Applicable",
  reviewRequired: false,
  source: { number: "2024-01-02" },
  tasks: [
    { uuid: "t1", description: "Inspect" },
    { uuid: "t2", description: "Replace" },
    { uuid: "t3", description: "Report" },
    { uuid: "t4", description: "Lubricate" },
  ],
} as unknown as AD;

beforeEach(() => {
  ui.status = "Scheduled";
  ui.tasks = { t1: "Scheduled", t2: "Overdue", t3: "Complied", t4: "Due soon" };
  ui.added = undefined;
});

function render(fields: Partial<AD> = {}, taskUuid?: string) {
  const ad = { ...record, ...fields };
  return renderToStaticMarkup(
    h(ADWorkOrderButton, { state, record: ad, taskUuid }),
  );
}

describe("ADWorkOrderButton", () => {
  it("offers every scheduled, due-soon or overdue action", () => {
    expect(render()).toBe("[AddToWorkOrder]");
    expect(ui.added).toEqual({
      aircraftUuid: "demo-206",
      sources: ["t1", "t2", "t4"].map((uuid) => ({
        source: { kind: "airworthiness", uuid },
        description: `AD 2024-01-02: ${record.tasks.find((t) => t.uuid === uuid)!.description}`,
      })),
    });
  });

  it("offers one action by itself", () => {
    expect(render({}, "t2")).toBe("[AddToWorkOrder]");
    expect(ui.added).toEqual({
      aircraftUuid: "demo-206",
      source: { kind: "airworthiness", uuid: "t2" },
    });
    expect(render({}, "t3")).toBe("");
  });

  it("offers nothing for an AD under review, not tracked or removed", () => {
    expect(
      render({ applicability: "Previously Complied With (PCW)" }),
    ).not.toBe("");
    expect(render({ reviewRequired: true })).toBe("");
    expect(render({ applicability: "Not applicable" })).toBe("");
    ui.status = "Removed component";
    expect(render()).toBe("");
  });

  it("offers nothing when no action is open", () => {
    ui.tasks = {};
    expect(render()).toBe("");
  });
});
