import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { aircraftStatus, dispatchGate } from "./aircraftStatus";
import {
  adStatus,
  adTaskStatus,
  blankAD,
  blankADTask,
  type ADTask,
} from "./airworthiness";
import { localDate, totalSeconds, type Snapshot } from "./model";

// The app-wide rule (GLOSSARY "Overdue"): a usage limit (hours, cycles,
// landings) is reached at 0 remaining, because the next flight would exceed
// it; a calendar limit stays valid through the end of its due date.
const today = localDate();
const N206 = "demo-206";
const addDays = (n: number) =>
  new Date(Date.parse(today + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);

function withAD(limit: Partial<ADTask>) {
  const s = demoSnapshot();
  // Only the AD under test may affect N206MA.
  s.inspections = s.inspections.filter((i) => i.aircraftUuid !== N206);
  s.discrepancies = s.discrepancies.filter((d) => d.aircraftUuid !== N206);
  s.management = [];
  const r = blankAD(N206);
  r.source.number = "2026-09-09";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect",
      recurrence: "One-time",
      ...limit,
    },
  ];
  s.airworthiness = [r];
  return { s, r };
}
const aircraft = (s: Snapshot) => s.aircraft.find((a) => a.uuid === N206)!;
const hoursNow = () => totalSeconds(aircraft(demoSnapshot())) / 3600;

/** What the AD and the aircraft report for the limit. */
function views(limit: Partial<ADTask>) {
  const { s, r } = withAD(limit);
  let gate: "blocked" | "open";
  try {
    dispatchGate(s, N206, undefined, today);
    gate = "open";
  } catch {
    gate = "blocked";
  }
  return {
    task: adTaskStatus(s, r, r.tasks[0], today),
    ad: adStatus(s, r),
    aircraft: aircraftStatus(s, N206, today).level,
    gate,
  };
}
const overdue = {
  task: "Overdue",
  ad: "Overdue",
  aircraft: "grounded",
  gate: "blocked",
};
const dueSoon = {
  task: "Due soon",
  ad: "Due soon",
  aircraft: "due-soon",
  gate: "open",
};

describe("AD due boundaries", () => {
  it("reaches an hours limit at 0 remaining", () => {
    expect(views({ dueHours: hoursNow() - 0.1 })).toEqual(overdue);
    expect(views({ dueHours: hoursNow() })).toEqual(overdue);
    expect(views({ dueHours: hoursNow() + 0.1 })).toEqual(dueSoon);
    // A limit that differs from the total only by floating-point noise
    // (2241.2 + 100 is not exactly 2341.2) is still reached.
    const noisy = hoursNow() - 100 + 100;
    expect(views({ dueHours: noisy + 1e-12 })).toEqual(overdue);
  });
  it("reaches a cycles or landings limit at 0 remaining", () => {
    const a = aircraft(demoSnapshot());
    expect(views({ dueCycles: a.cycles })).toEqual(overdue);
    expect(views({ dueCycles: a.cycles + 1 })).toEqual(dueSoon);
    expect(views({ dueLandings: a.landings })).toEqual(overdue);
    expect(views({ dueLandings: a.landings! + 1 })).toEqual(dueSoon);
  });
  it("keeps a calendar limit valid through its due date", () => {
    expect(views({ dueDate: addDays(-1) })).toEqual(overdue);
    expect(views({ dueDate: today })).toEqual(dueSoon);
    expect(views({ dueDate: addDays(1) })).toEqual(dueSoon);
    expect(views({ dueDate: addDays(31) }).task).toBe("Scheduled");
  });
});
