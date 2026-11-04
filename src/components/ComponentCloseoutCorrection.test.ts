/**
 * Responsibility: Pins when the component close-out corrections panel shows,
 *   who may start a correction, and how past corrections are listed.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ComponentCloseoutCorrection.tsx,
 *   react-dom/server, src/data/demo.ts (seed), tests/fixtures/workOrders.ts.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import {
  saveWorkOrder,
  workOrderFieldsSchema,
  type WorkOrder,
} from "../domain/workOrders";
import type { ComponentCorrectionCommand } from "../domain/workOrderComponentCorrections";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import { ComponentCloseoutCorrection } from "./ComponentCloseoutCorrection";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({ useWorkspace: () => workspace.state }));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY_MS = 86_400_000;
type WorkAction = ComponentCorrectionCommand["choice"]["action"];
let s: Snapshot;
let closed: WorkOrder;

beforeEach(() => {
  s = demoSnapshot();
  s.management = [workOrderComponent()];
  closed = closeWithOverhaul();
  workspace.state = { snapshot: s, online: true, connected: true };
});

function closeWithOverhaul() {
  const cmd = { ...workOrderCommand(), componentUuids: ["engine"] };
  const open = saveWorkOrder(s, cmd, NOW);
  const fields = workOrderFieldsSchema.parse(open);
  return saveWorkOrder(
    s,
    {
      ...cmd,
      version: open.version,
      fields: {
        ...fields,
        status: "completed",
        completionDate: "2026-10-02",
        releaseOutcome: "Reviewed",
        finalReview: "Reviewed",
      },
      componentWork: [
        {
          componentUuid: "engine",
          version: s.management![0].version,
          action: "overhaul",
          description: "Bench work",
          reference: "AMM",
        },
      ],
    },
    NOW,
  );
}

function correct(order: WorkOrder, action: WorkAction, at: number) {
  const component = s.management!.find((r) => r.uuid === "engine")!;
  const choice = {
    componentUuid: "engine",
    version: component.version,
    action,
    description: "Correct work",
    reference: "AMM",
  };
  return saveWorkOrder(
    s,
    {
      action: "correctComponent",
      uuid: order.uuid,
      version: order.version,
      aircraftVersion: s.aircraft[0].version,
      reason: `To ${action}`,
      choice,
    },
    at,
  );
}

const render = (order: WorkOrder) =>
  renderToStaticMarkup(
    h(ComponentCloseoutCorrection, { order, onDone: () => undefined }),
  );

describe("when the panel shows", () => {
  it("shows nothing for a work order that is not completed", () => {
    expect(render({ ...closed, status: "open" })).toBe("");
  });

  it("shows nothing when the close-out only moved components", () => {
    const moved = structuredClone(closed);
    moved.closeout!.componentWork![0].action = "install";
    expect(render(moved)).toBe("");
  });

  it("lets a maintainer start a correction only while connected", () => {
    const button = /<button[^>]*>Correct component closeout<\/button>/;
    expect(render(closed).match(button)![0]).not.toContain("disabled");
    workspace.state.connected = false;
    expect(render(closed).match(button)![0]).toContain('disabled=""');
  });

  it("does not let a user without the maintenance permission start one", () => {
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    expect(render(closed)).toMatch(/disabled="">Correct component closeout/);
  });
});

describe("past corrections", () => {
  it("lists them newest first with their addenda", () => {
    const once = correct(closed, "repair", NOW + DAY_MS);
    const twice = correct(once, "both", NOW + 2 * DAY_MS);
    const html = render(twice);
    expect(html).toContain("Logbook review required");
    expect(html.indexOf("Reason: To both")).toBeLessThan(
      html.indexOf("Reason: To repair"),
    );
    expect(html.match(/Download correction addendum/g)).toHaveLength(2);
  });

  it("are not mentioned before the first correction", () => {
    expect(render(closed)).not.toContain("Logbook review required");
    const none = { ...closed, componentCorrections: [] };
    expect(render(none)).not.toContain("Logbook review required");
  });
});
