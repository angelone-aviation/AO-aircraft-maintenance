/**
 * Responsibility: Pins what the owner portal lists for an aircraft and when
 *   it offers to leave the demo's owner preview. The exports need a browser:
 *   tests/e2e/aircraft-status-export.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/OwnerPortal.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import { OwnerPortal } from "./OwnerPortal";

const base = demoSnapshot();
const aircraftUuid = base.aircraft[0].uuid;
const order = (day: number, status = "completed") => ({
  uuid: `wo-${day}`,
  aircraftUuid,
  status,
  number: `WO-DAY-${day}`,
  completionDate: `2026-10-${String(day).padStart(2, "0")}`,
  scope: "",
});
const report = (description: string, status: string) => ({
  ...base.discrepancies[0],
  uuid: description,
  aircraftUuid,
  status,
  description,
});
const workspace = {
  demo: false,
  snapshot: {
    ...base,
    aircraft: base.aircraft.slice(0, 1),
    workOrders: [1, 7, 3, 5, 2, 6]
      .map((d) => order(d))
      .concat(order(9, "open")),
    discrepancies: [
      report("Cracked fairing", "open"),
      report("Old leak", "resolved"),
    ],
  } as Snapshot,
};
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace, { getState: () => workspace }),
  previewDemoOwner: async () => {},
}));
const render = () => renderToStaticMarkup(createElement(OwnerPortal));

describe("OwnerPortal", () => {
  it("lists the five most recently completed work orders, newest first", () => {
    const numbers = render().match(/WO-DAY-\d/g);
    expect(numbers).toEqual([
      "WO-DAY-7",
      "WO-DAY-6",
      "WO-DAY-5",
      "WO-DAY-3",
      "WO-DAY-2",
    ]);
  });

  it("lists open discrepancies only", () => {
    expect(render()).toContain("Cracked fairing");
    expect(render()).not.toContain("Old leak");
  });

  it("offers to leave the owner preview only in the demo", () => {
    expect(render()).not.toContain("Exit owner preview");
    workspace.demo = true;
    expect(render()).toContain("Exit owner preview");
    workspace.demo = false;
  });
});
