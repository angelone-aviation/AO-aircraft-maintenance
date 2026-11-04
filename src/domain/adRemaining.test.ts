/**
 * Responsibility: Pins the AD task "remaining" rows: order, overdue and due-now
 *   values, missing counters, and the tasks that show none.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/adRemaining.ts, ./airworthiness, src/data/demo.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask, adCounters } from "./airworthiness";
import { adRemaining } from "./adRemaining";

describe("AD recurrence remaining", () => {
  it("uses aircraft totals and displays only configured recurrence counters", () => {
    const s = demoSnapshot();
    const r = blankAD(s.aircraft[0].uuid);
    const current = adCounters(s, r)!;
    const t = {
      ...blankADTask(),
      intervalHours: 100,
      dueHours: current.hours + 42.5,
      dueCycles: 1,
    };
    expect(adRemaining(s, r, t)).toEqual([
      { label: "Hours remaining", value: "42.5" },
    ]);
    t.intervalHours = 0;
    expect(adRemaining(s, r, t)).toEqual([]);
  });
  it("reports overdue counters and approximate months from the actual deadline", () => {
    const s = demoSnapshot();
    const r = blankAD(s.aircraft[0].uuid);
    const current = adCounters(s, r)!;
    const t = {
      ...blankADTask(),
      intervalDays: 365,
      dueDate: "2026-10-01",
      intervalCycles: 100,
      dueCycles: current.cycles - 12,
    };
    expect(adRemaining(s, r, t, "2026-11-01")).toEqual([
      { label: "Months remaining (approx.)", value: "1.0 overdue" },
      { label: "Cycles remaining", value: "12 overdue" },
    ]);
  });
  it("shows a usage limit with nothing left as due now", () => {
    const s = demoSnapshot();
    const r = blankAD(s.aircraft[0].uuid);
    const current = adCounters(s, r)!;
    const t = {
      ...blankADTask(),
      intervalHours: 100,
      dueHours: current.hours,
      intervalCycles: 100,
      dueCycles: current.cycles,
      intervalLandings: 100,
      dueLandings: current.landings,
    };
    expect(adRemaining(s, r, t).map((row) => row.value)).toEqual([
      "Due now",
      "Due now",
      "Due now",
    ]);
    t.dueHours = current.hours - 0.1;
    expect(adRemaining(s, r, t)[0].value).toBe("0.1 overdue");
  });
  it("does not invent due values or show one-time or terminated recurrence", () => {
    const s = demoSnapshot();
    const r = blankAD(s.aircraft[0].uuid);
    const t = { ...blankADTask(), intervalHours: 100 };
    expect(adRemaining(s, r, t)[0].value).toBe("Due not set");
    t.recurrence = "One-time";
    expect(adRemaining(s, r, t)).toEqual([]);
    t.recurrence = "Recurring";
    r.applicability = "Not applicable";
    expect(adRemaining(s, r, t)).toEqual([]);
  });
  it("uses engine counters rather than aircraft counters and respects disabled tracking", () => {
    const s = demoSnapshot();
    const component: import("./components").Component = {
      uuid: "test-engine",
      version: 1,
      kind: "component",
      aircraftUuid: s.aircraft[0].uuid,
      componentType: "Engine",
      partNumber: "TEST",
      serial: "TEST",
      manufacturer: "Test",
      notes: "",
      installed: true,
      installedSeconds: 0,
      installedCycles: 0,
      trackTime: true,
      trackCycles: true,
      trackCalendar: false,
      timeSinceNew: 100 * 3600,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 50,
      serviceDaysBase: 0,
    };
    s.management = [component];
    const r = blankAD(component.aircraftUuid, "Engine");
    r.componentUuid = component.uuid;
    const current = adCounters(s, r)!;
    const t = {
      ...blankADTask(),
      intervalHours: 100,
      dueHours: current.hours + 25,
    };
    component.trackTime = true;
    expect(adRemaining(s, r, t)[0].value).toBe("25.0");
    component.trackTime = false;
    expect(adRemaining(s, r, t)[0].value).toBe("Counter unavailable");
  });
  it("lists hours, months, cycles and landings in order, and a calendar 0 is not due now", () => {
    const s = demoSnapshot();
    const r = blankAD(s.aircraft[0].uuid);
    const current = adCounters(s, r)!;
    const t = {
      ...blankADTask(),
      intervalHours: 100,
      dueHours: current.hours + 2,
      intervalDays: 365,
      dueDate: "2026-11-01",
      intervalCycles: 100,
      dueCycles: current.cycles + 3,
      intervalLandings: 100,
      dueLandings: current.landings + 4,
    };
    expect(adRemaining(s, r, t, "2026-11-01")).toEqual([
      { label: "Hours remaining", value: "2.0" },
      { label: "Months remaining (approx.)", value: "0.0" },
      { label: "Cycles remaining", value: "3" },
      { label: "Landings remaining", value: "4" },
    ]);
  });
  it("shows nothing once the task is terminated or the AD superseded", () => {
    const s = demoSnapshot();
    const r = blankAD(s.aircraft[0].uuid);
    const t = { ...blankADTask(), intervalHours: 100, dueHours: 1 };
    expect(adRemaining(s, r, t)).toHaveLength(1);
    r.applicability = "Superseded";
    expect(adRemaining(s, r, t)).toEqual([]);
    r.applicability = blankAD(s.aircraft[0].uuid).applicability;
    r.history = [
      {
        uuid: crypto.randomUUID(),
        taskUuid: t.uuid,
        date: "2026-01-01",
        hours: null,
        cycles: null,
        method: "Terminating action",
        serviceBulletin: "",
        terminatedBy: "SB 12",
        workOrderUuid: "",
        mechanic: "A. Mechanic",
        certificate: "",
        evidence: "",
        recordedAt: 0,
        recordedBy: "test",
      },
    ];
    expect(adRemaining(s, r, t)).toEqual([]);
  });
  it("reports a missing counter for landings when the AD's aircraft is unknown", () => {
    const s = demoSnapshot();
    const r = blankAD("no-such-aircraft");
    const t = { ...blankADTask(), intervalLandings: 100, dueLandings: 5 };
    expect(adRemaining(s, r, t)).toEqual([
      { label: "Landings remaining", value: "Counter unavailable" },
    ]);
  });
});
