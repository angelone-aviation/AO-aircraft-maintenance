/**
 * Responsibility: Pins that a component baseline or an aircraft total-time
 *   correction is refused below the recorded compliance of a component
 *   requirement or an AD, naming the record that blocks it, and accepted at
 *   exactly that compliance.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/airworthiness.ts, components.ts, fleet.ts,
 *   management.ts, model.ts, src/data/demo.ts, tests/fixtures/workOrders.ts.
 */
import { describe, expect, it } from "vitest";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { demoSnapshot } from "../data/demo";
import {
  applyADCommand,
  blankAD,
  blankADTask,
  type ADCompliance,
} from "./airworthiness";
import { requirementSchema, type Component } from "./components";
import { aircraftInputSchema, applyFleet } from "./fleet";
import { applyManagement } from "./management";
import { totalSeconds, type Snapshot } from "./model";

const HOUR = 3600;
const NOW = Date.parse("2026-11-10T15:00:00Z");
const TODAY = "2026-11-10";

function compliance(
  taskUuid: string,
  over: Partial<ADCompliance>,
): ADCompliance {
  return {
    uuid: crypto.randomUUID(),
    taskUuid,
    date: "2026-11-01",
    hours: null,
    cycles: null,
    method: "Inspected per paragraph (g)",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "A Mechanic",
    certificate: "",
    evidence: "",
    recordedAt: 0,
    recordedBy: "",
    ...over,
  };
}

// Records an applicable AD every 100 h or 100 cycles, complied with once.
function addCompliedAD(
  s: Snapshot,
  componentUuid: string,
  entry: Partial<ADCompliance>,
) {
  const r = blankAD(s.aircraft[0].uuid, componentUuid ? "Engine" : undefined);
  r.componentUuid = componentUuid;
  r.source = { ...r.source, number: "2026-01-01", subject: "Repetitive" };
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect",
      intervalHours: 100,
      intervalCycles: 100,
      dueHours: 1,
      dueCycles: 1,
      recurrence: "Recurring",
    },
  ];
  applyADCommand(s, { kind: "save", record: r }, NOW);
  const saved = s.airworthiness!.at(-1)!;
  const { uuid, version } = saved;
  const done = compliance(saved.tasks[0].uuid, entry);
  applyADCommand(s, { kind: "comply", uuid, version, entry: done }, NOW);
}

// An engine at 490 h and 400 cycles since new.
function engineSnapshot() {
  const s = demoSnapshot();
  s.inspections = [];
  s.airworthiness = [];
  const engine: Component = {
    ...workOrderComponent(),
    programUuid: "demo-program",
    installPosition: "LEFT",
    timeSinceNew: 490 * HOUR,
    cyclesSinceNew: 400,
  };
  s.management = [engine];
  return { s, a: s.aircraft[0], engine };
}

function requirement(engine: Component, last: object) {
  return requirementSchema.parse({
    uuid: "every-100",
    kind: "componentRequirement",
    version: 1,
    componentUuid: engine.uuid,
    aircraftUuid: engine.aircraftUuid,
    programUuid: "demo-program",
    requirementType: "Inspection Requirement",
    description: "Inspect every 100 h",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "FROM_LAST_COMPLIED",
    cycleLimitMode: "FROM_LAST_COMPLIED",
    intervalSeconds: 100 * HOUR,
    intervalCycles: 100,
    warningCalendarMonths: 0,
    warningSeconds: 10 * HOUR,
    warningCycles: 5,
    ...last,
  });
}

function setBaseline(s: Snapshot, engine: Component, hours: number) {
  const a = s.aircraft[0];
  const current = s.management!.find((r) => r.uuid === engine.uuid)!;
  return applyManagement(
    s,
    {
      requestUuid: crypto.randomUUID(),
      reason: "Verified against the engine logbook",
      action: "component.baseline",
      uuid: engine.uuid,
      version: current.version ?? 0,
      installedSeconds: totalSeconds(a),
      installedCycles: a.cycles,
      timeSinceNew: hours * HOUR,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 390,
      serviceDaysBase: 0,
      installedDate: TODAY,
    },
    NOW,
  );
}

describe("Set baseline", () => {
  it("is refused below a requirement's last compliance, naming it", () => {
    const { s, engine } = engineSnapshot();
    s.management!.push(
      requirement(engine, {
        lastSeconds: 480 * HOUR,
        dueSeconds: 580 * HOUR,
      }),
    );
    expect(() => setBaseline(s, engine, 300)).toThrow(
      'Baseline would precede the last compliance of requirement "Inspect every 100 h".',
    );
    expect(() => setBaseline(s, engine, 480)).not.toThrow();
  });

  it("is refused below a requirement's last cycles", () => {
    const { s, engine } = engineSnapshot();
    s.management!.push(requirement(engine, { lastCycles: 395 }));
    expect(() => setBaseline(s, engine, 490)).toThrow(
      "Baseline would precede the last compliance of requirement",
    );
  });

  it("is refused below a component AD's compliance hours, naming the AD", () => {
    const { s, engine } = engineSnapshot();
    addCompliedAD(s, engine.uuid, { hours: 480, cycles: 380 });
    expect(() => setBaseline(s, engine, 300)).toThrow(
      "Baseline would precede the last compliance of AD 2026-01-01.",
    );
    expect(() => setBaseline(s, engine, 480)).not.toThrow();
  });

  it("ignores AD hours on a component that does not track time", () => {
    const { s, engine } = engineSnapshot();
    addCompliedAD(s, engine.uuid, { hours: 480, cycles: 380 });
    Object.assign(s.management![0], { trackTime: false });
    expect(() => setBaseline(s, engine, 300)).not.toThrow();
  });
});

describe("Aircraft total-time correction", () => {
  function correctTo(s: Snapshot, totalHours: number) {
    const a = s.aircraft[0];
    const meter = totalSeconds(a) - a.adjustmentSeconds;
    return applyFleet(
      s,
      {
        requestUuid: crypto.randomUUID(),
        reason: "Total time corrected after a logbook audit",
        action: "aircraft.save",
        aircraft: aircraftInputSchema.parse({
          ...a,
          adjustmentSeconds: Math.round(totalHours * HOUR - meter),
        }),
      },
      NOW,
    );
  }

  function aircraftWithAD(entry: Partial<ADCompliance>) {
    const s = demoSnapshot();
    Object.assign(s, { inspections: [], flights: [], airworthiness: [] });
    addCompliedAD(s, "", entry);
    return s;
  }

  it("is refused below an aircraft AD's compliance hours, naming the AD", () => {
    const s = aircraftWithAD({ hours: 2340, cycles: 1 });
    expect(() => correctTo(s, 2000)).toThrow(
      "Correction would move usage before the recorded compliance of AD 2026-01-01.",
    );
    expect(() => correctTo(s, 2340)).not.toThrow();
  });

  it("is refused below an aircraft AD's compliance cycles", () => {
    const s = aircraftWithAD({ hours: 2000, cycles: 1800 });
    const a = s.aircraft[0];
    const input = aircraftInputSchema.parse({ ...a, cycles: 1799 });
    const save = () =>
      applyFleet(
        s,
        {
          requestUuid: crypto.randomUUID(),
          reason: "Cycles corrected after a logbook audit",
          action: "aircraft.save",
          aircraft: input,
        },
        NOW,
      );
    expect(save).toThrow("before the recorded compliance of AD 2026-01-01.");
  });

  // The correction moves the engine's installation baseline with the
  // aircraft, so its time since new, which the AD counts, is unchanged.
  it("leaves a component AD to its component's baseline", () => {
    const { s, engine } = engineSnapshot();
    s.flights = [];
    addCompliedAD(s, engine.uuid, { hours: 480, cycles: 380 });
    expect(() =>
      correctTo(s, totalSeconds(s.aircraft[0]) / HOUR - 1),
    ).not.toThrow();
  });
});
