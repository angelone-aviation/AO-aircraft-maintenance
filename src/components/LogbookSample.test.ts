/**
 * Responsibility: Pins what the sample log book entry shows before and after
 *   the order is marked completed, against the entry the saved order writes.
 *   Unticking unfinished work needs a browser: logbook-wording.spec.ts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/LogbookSample.tsx, src/domain (workOrders,
 *   logbook), src/data/demo.ts (demoSnapshot), tests/fixtures/workOrders,
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  newWorkTask,
  saveWorkOrder,
  type WorkOrder,
  type WorkOrderCommand,
  type WorkTask,
} from "../domain/workOrders";
import { logbookText } from "../domain/logbook";
import type { Snapshot } from "../domain/model";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
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

  it("renders nothing for an aircraft not in the snapshot", () => {
    expect(render("open", "missing")).toBe("");
  });
});

describe("LogbookSample against the saved entry", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");

  // An order on the first aircraft for the fixture engine, at the left
  // position, with one finished item whose wording is in the entry.
  function order() {
    const s = demoSnapshot();
    s.management = [{ ...workOrderComponent(), installPosition: "LEFT" }];
    const command = workOrderCommand();
    const item = newWorkTask({ kind: "manual", uuid: "manual" }, "Dress");
    command.tasks = [{ ...item, includeInLogbook: true, status: "completed" }];
    command.componentUuids = ["engine"];
    return { s, command };
  }

  // A new order is saved open first, then saved again as the command says.
  function savedEntry(s: Snapshot, command: SaveCommand) {
    const fields = { ...command.fields, status: "open" as const };
    const opened = saveWorkOrder(s, { ...command, fields }, now);
    const again = { ...command, version: opened.version };
    const saved = isOpen(command) ? opened : saveWorkOrder(s, again, now);
    const signer = { userId: s.user.id, name: s.user.name, ...noLicense };
    return {
      saved,
      text: logbookText(
        s,
        saved,
        "maintenance",
        signer,
        undefined,
        undefined,
        true,
      ),
    };
  }

  function sample(s: Snapshot, command: SaveCommand, fields: FormData) {
    const markup = renderToStaticMarkup(
      createElement(LogbookSample, {
        s,
        uuid: command.uuid,
        aircraftUuid: command.fields.aircraftUuid,
        componentUuids: command.componentUuids,
        tasks: command.tasks,
        status: command.fields.status,
        fields,
        releaseOutcome: command.fields.releaseOutcome,
        componentWork: command.componentWork ?? [],
      }),
    );
    return unescape(/<textarea[^>]*>([\s\S]*)<\/textarea>/.exec(markup)![1]);
  }

  it("labels a header component with its position, as saving does", () => {
    const { s, command } = order();
    const preview = sample(s, command, new FormData());
    const { text } = savedEntry(structuredClone(s), command);
    const block = linesFrom(text, "Component:", 3);
    expect(block[0]).toBe("Component: Engine · LEFT");
    expect(linesFrom(preview, "Component:", 3)).toEqual(block);
  });

  it("writes component work and readings as the close-out does", () => {
    const { s, command } = order();
    command.fields = {
      ...command.fields,
      status: "completed",
      completionDate: "2026-10-01",
      releaseOutcome: "Released",
    };
    command.componentWork = [
      {
        componentUuid: "engine",
        version: 0,
        action: "repair",
        description: "Blade dressed",
        reference: "SB 1",
      },
    ];
    const fields = new FormData();
    fields.set("completionDate", "2026-10-01");
    const before = structuredClone(s);
    const preview = sample(s, command, fields);
    expect(s).toEqual(before);
    const { saved, text } = savedEntry(structuredClone(s), command);
    const work = saved.closeout!.workPerformed;
    expect(work).toContain(
      "Engine · LEFT (P/N PN; S/N SN): Repaired on 2026-10-01. Blade dressed IAW SB 1. TSN 110.0 h; TSO 30.0 h; TSR 0.0 h.",
    );
    expect(preview).toContain(`Work performed:\n${work}\n`);
    expect(linesFrom(preview, "Aircraft total time:", 1)).toEqual(
      linesFrom(text, "Aircraft total time:", 1),
    );
    const openFields = { ...command.fields, status: "open" as const };
    expect(sample(s, { ...command, fields: openFields }, fields)).not.toContain(
      "Blade dressed",
    );
  });

  it("previews a removal as the close-out writes it, changing nothing", () => {
    const { s, command } = order();
    command.fields = {
      ...command.fields,
      status: "completed",
      completionDate: "2026-10-01",
      releaseOutcome: "Released",
    };
    command.componentWork = [
      {
        componentUuid: "engine",
        version: 0,
        action: "remove",
        taskUuid: command.tasks[0].uuid,
        partsLocation: "Shelf",
        description: "Removed for overhaul",
        reference: "",
      },
    ];
    const fields = new FormData();
    fields.set("completionDate", "2026-10-01");
    const before = structuredClone(s);
    const preview = sample(s, command, fields);
    expect(s).toEqual(before);
    const work = savedEntry(structuredClone(s), command).saved.closeout!
      .workPerformed;
    expect(work).toContain("Removed from aircraft");
    expect(preview).toContain(`Work performed:\n${work}\n`);
  });

  it("leaves component work out while closing would refuse it", () => {
    const { s, command } = order();
    command.fields = { ...command.fields, status: "completed" };
    const repair = {
      componentUuid: "engine",
      version: 0,
      action: "repair" as const,
      description: "Blade dressed",
      reference: "",
    };
    const fields = new FormData();
    fields.set("completionDate", "2026-10-01");
    const withWork = (work: (typeof repair)[]) =>
      sample(s, { ...command, componentWork: work }, fields);
    expect(withWork([repair])).toContain("Repaired on 2026-10-01");
    expect(withWork([{ ...repair, description: "" }])).not.toContain(
      "Repaired on",
    );
    expect(
      withWork([repair, { ...repair, componentUuid: "other" }]),
    ).not.toContain("Repaired on");
  });
});

type SaveCommand = Extract<WorkOrderCommand, { action: "save" }>;

const noLicense = { licenseNumber: "", certificateType: "" };

const isOpen = (command: SaveCommand) => command.fields.status === "open";

function linesFrom(text: string, start: string, count: number) {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith(start));
  return lines.slice(first, first + count);
}

function unescape(html: string) {
  return html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}
