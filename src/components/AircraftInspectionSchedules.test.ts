/**
 * Responsibility: Pins which inspections the schedule list shows, how each
 *   sort orders them, and how a remaining limit and the status read.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AircraftInspectionSchedules.tsx,
 *   react-dom/server, src/data/demo.ts (seed), src/domain/management.ts.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { inspectionCounters } from "../domain/management";
import type { Inspection, Snapshot } from "../domain/model";
import { AircraftInspectionSchedules } from "./AircraftInspectionSchedules";

const order = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  // The list's one state is its sort order, which a test sets directly.
  return {
    ...react,
    useState: (initial: unknown) => [order.current ?? initial, () => {}],
  };
});

let s: Snapshot;

beforeEach(() => {
  s = demoSnapshot();
  order.current = undefined;
});

function inspection(
  reference: string,
  fields: Partial<Inspection> = {},
): Inspection {
  return {
    uuid: `${reference}-uuid`,
    aircraftUuid: s.aircraft[0].uuid,
    reference,
    description: "Airframe",
    ...fields,
  };
}

const cyclesLeft = (n: number) => ({ dueCycles: s.aircraft[0].cycles + n });

function render(sort = "name", descending = false) {
  order.current = { sort, descending };
  return renderToStaticMarkup(
    h(AircraftInspectionSchedules, { aircraft: s.aircraft[0], state: s }),
  );
}

function names(sort?: string, descending?: boolean) {
  const html = render(sort, descending);
  return [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map((m) => m[1]);
}

describe("AircraftInspectionSchedules", () => {
  it("lists the aircraft's active inspections by name, numbers in order", () => {
    s.inspections = [
      inspection("Item 10"),
      inspection("item 2"),
      inspection("Annual", { archived: true }),
      inspection("", { description: "Brakes" }),
      inspection("Other aircraft", { aircraftUuid: s.aircraft[1].uuid }),
    ];
    expect(names()).toEqual(["Brakes", "item 2", "Item 10"]);
    expect(names("name", true)).toEqual(["Item 10", "item 2", "Brakes"]);
  });

  it("sorts by what remains, ties by name, without that limit last", () => {
    s.inspections = [
      inspection("C", cyclesLeft(5)),
      inspection("D"),
      inspection("A", cyclesLeft(5)),
      inspection("B", cyclesLeft(-2)),
    ];
    expect(names("cycles")).toEqual(["B", "A", "C", "D"]);
    expect(names("cycles", true)).toEqual(["A", "C", "B", "D"]);
  });

  it("reads each limit as remaining, due now or overdue, with the status", () => {
    const aircraft = s.aircraft[0];
    const base = inspection("Check");
    const seconds = inspectionCounters(base, aircraft, s.management).seconds;
    if (seconds === undefined) throw new Error("the demo aircraft has a meter");
    s.inspections = [
      {
        ...base,
        dueSeconds: seconds + 5400,
        dueCycles: aircraft.cycles,
        dueLandings: aircraft.landings - 3,
      },
    ];
    const html = render();
    expect(html).toContain("1.5 hours remaining<");
    expect(html).toContain("0 cycles remaining — due now<");
    expect(html).toContain("3 landings overdue<");
    expect(html).toContain(
      '<span class="ds-pill ds-tone-danger"><span class="ds-pill-dot" aria-hidden="true"></span>Overdue</span>',
    );
  });

  it("says when no limit is known, and when there are no inspections", () => {
    s.inspections = [
      inspection("Open"),
      inspection("Exempt", { calendarExempt: true }),
    ];
    const html = render();
    expect(html).toContain("Remaining units not available");
    expect(html).toContain(
      '<span class="ds-pill ds-tone-neutral"><span class="ds-pill-dot" aria-hidden="true"></span>Unknown</span>',
    );
    expect(html).toContain("Calendar exempt");
    expect(html).toContain(
      '<span class="ds-pill ds-tone-neutral"><span class="ds-pill-dot" aria-hidden="true"></span>Scheduled</span>',
    );
    s.inspections = [];
    expect(render()).toContain("<h3>Inspection information missing</h3>");
  });
});
