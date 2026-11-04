/**
 * Responsibility: Pins what the sample log book entry shows before and after
 *   the order is marked completed. Unticking unfinished work needs a browser:
 *   tests/e2e/logbook-wording.spec.ts covers it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/LogbookSample.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { WorkOrder, WorkTask } from "../domain/workOrders";
import type { ComponentWork } from "../domain/workOrderComponentWork";
import { LogbookSample } from "./LogbookSample";

const component = {
  kind: "component",
  uuid: "prop",
  version: 1,
  installed: true,
  aircraftUuid: "demo-206",
  componentType: "Propeller",
  serial: "S1",
  partNumber: "P1",
};
const s = {
  ...demoSnapshot(),
  management: [component],
} as ReturnType<typeof demoSnapshot>;
const task = {
  uuid: "00000000-0000-4000-8000-000000000001",
  source: { kind: "manual", uuid: "" },
  description: "Replace the left brake pads",
  status: "requested",
  notes: "",
  partsDelay: "",
} as WorkTask;
const repair = {
  componentUuid: "prop",
  version: 1,
  action: "repair",
  description: "Blade dressed",
  reference: "",
} as ComponentWork;
const fields = new FormData();
fields.set("completionHobbs", "4321.5");

const render = (status: WorkOrder["status"], aircraftUuid = "demo-206") =>
  renderToStaticMarkup(
    createElement(LogbookSample, {
      s,
      uuid: "order",
      aircraftUuid,
      componentUuids: [],
      tasks: [task],
      status,
      fields,
      releaseOutcome: "",
      componentWork: [repair],
    }),
  );

describe("LogbookSample", () => {
  it("includes unfinished work by default", () => {
    expect(render("open")).toContain("Replace the left brake pads");
  });

  it("keeps the opening header until the order is completed", () => {
    expect(render("open")).not.toContain("4321.5 h");
    expect(render("completed")).toContain("Hobbs: 4321.5 h");
  });

  it("lists component work only on a completed order", () => {
    expect(render("open")).not.toContain("Blade dressed");
    expect(render("completed")).toContain(
      "Propeller (P/N P1; S/N S1): Repaired on [completion date]. Blade dressed. TSR resets to 0.0 h.",
    );
  });

  it("renders nothing for an aircraft not in the snapshot", () => {
    expect(render("open", "missing")).toBe("");
  });
});
