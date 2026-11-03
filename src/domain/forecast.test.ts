import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask, adCounters } from "./airworthiness";
import type { Component, ComponentRequirement } from "./components";
import {
  totalSeconds,
  type Flight,
  type Inspection,
  type Snapshot,
} from "./model";
import { addDays, forecast, projectDue, utilization, weekOf } from "./forecast";

const today = "2026-10-30";
const aircraftUuid = "demo-206";
const H = 3600;
// Flight on a date, `hrs` on the hobbs meter (aircraft uses hobbs).
function flight(
  date: string,
  hrs: number,
  extra: Partial<Flight> = {},
): Flight {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid,
    pilotId: "p",
    authorId: "p",
    submittedAt: 0,
    status: "accepted",
    startTime: `${date}T12:00:00-04:00`,
    hobbsOff: 1000 * H,
    hobbsOn: 1000 * H + hrs * H,
    landings: 2,
    cycles: 1,
    origin: "",
    destination: "",
    operation: "Private",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...extra,
  };
}
// One 2 h flight every 10 days for the last 90 days → 18 h / 90 days = 0.2 h/day;
// an older flight shows history predates the window.
const steady = [
  ...Array.from({ length: 9 }, (_, n) =>
    flight(addDays(today, -(n * 10 + 5)), 2),
  ),
  flight(addDays(today, -120), 40),
];
function state(flights: Flight[] = steady): Snapshot {
  const s = demoSnapshot();
  return { ...s, flights, inspections: [], airworthiness: [], management: [] };
}
function inspection(fields: Partial<Inspection>): Inspection {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid,
    reference: "100 h",
    description: "Inspection",
    ...fields,
  };
}
const aircraft = () => state().aircraft.find((a) => a.uuid === aircraftUuid)!;

describe("utilization", () => {
  it("reports insufficient data when no flights are logged", () => {
    expect(utilization(aircraft(), [], today).kind).toBe("insufficient");
  });
  it("averages accepted flights over the 90-day window", () => {
    const u = utilization(aircraft(), steady, today);
    expect(u).toMatchObject({ kind: "rate", flights: 9, days: 90 });
    if (u.kind !== "rate") throw new Error();
    expect(u.secondsPerDay).toBeCloseTo((18 * H) / 90);
    expect(u.cyclesPerDay).toBeCloseTo(9 / 90);
    expect(u.landingsPerDay).toBeCloseTo(18 / 90);
    expect(u.confidence).toBe("normal");
  });
  it("ignores flights held for review or rejected", () => {
    const held = steady.map((f) => ({ ...f, status: "review" as const }));
    expect(utilization(aircraft(), held, today).kind).toBe("insufficient");
  });
  it("falls back to all history when the window is thin", () => {
    const old = [
      flight("2026-01-10", 10),
      flight("2026-02-10", 10),
      flight(addDays(today, -3), 1),
    ];
    const u = utilization(aircraft(), old, today);
    if (u.kind !== "rate") throw new Error();
    expect(u.flights).toBe(3);
    expect(u.days).toBe(293);
    expect(u.note).toMatch(/all history/);
  });
  it("flags very recent flights as low confidence", () => {
    const u = utilization(
      aircraft(),
      [flight(addDays(today, -1), 3), flight(today, 1)],
      today,
    );
    if (u.kind !== "rate") throw new Error();
    expect(u.days).toBe(1);
    expect(u.secondsPerDay).toBe(4 * H);
    expect(u.confidence).toBe("low");
  });
  it("uses the window length when history extends before it", () => {
    const u = utilization(
      aircraft(),
      [flight("2025-01-01", 50), ...steady],
      today,
      30,
    );
    if (u.kind !== "rate") throw new Error();
    expect(u.days).toBe(30);
    expect(u.flights).toBe(3);
  });
});

describe("projectDue", () => {
  const rates = { secondsPerDay: 2 * H, cyclesPerDay: 0, landingsPerDay: 1 };
  it("rounds partial days up and exact multiples land on the day", () => {
    expect(projectDue({ seconds: 10 * H }, rates, today)?.date).toBe(
      addDays(today, 5),
    );
    expect(projectDue({ seconds: 10 * H + 1 }, rates, today)?.date).toBe(
      addDays(today, 6),
    );
  });
  it("uses the calendar when it comes before hours", () => {
    expect(
      projectDue({ seconds: 100 * H, dueDate: "2026-11-05" }, rates, today),
    ).toEqual({ date: "2026-11-05", basis: "calendar", overdue: false });
  });
  it("uses hours when they come before the calendar", () => {
    expect(
      projectDue({ seconds: 4 * H, dueDate: "2027-01-01" }, rates, today),
    ).toEqual({ date: "2026-11-01", basis: "hours", overdue: false });
  });
  it("never projects a zero-usage dimension", () => {
    expect(projectDue({ cycles: 10 }, rates, today)).toBeUndefined();
    expect(
      projectDue({ cycles: 10, dueDate: "2027-01-01" }, rates, today)?.basis,
    ).toBe("calendar");
  });
  it("places overdue items today", () => {
    expect(projectDue({ seconds: -H }, rates, today)).toEqual({
      date: today,
      basis: "hours",
      overdue: true,
    });
    expect(projectDue({ dueDate: "2026-10-01" }, {}, today)).toEqual({
      date: today,
      basis: "calendar",
      overdue: true,
    });
  });
  it("projects cycles-only and landings-only limits", () => {
    expect(projectDue({ cycles: 3 }, { cyclesPerDay: 0.5 }, today)?.date).toBe(
      addDays(today, 6),
    );
    expect(projectDue({ landings: 3 }, rates, today)?.basis).toBe("landings");
  });
});

describe("forecast", () => {
  it("projects inspections from aircraft utilization", () => {
    const s = state();
    const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
    s.inspections = [inspection({ dueSeconds: totalSeconds(a) + 2 * H })];
    const [item] = forecast(s, today);
    // 0.2 h/day → 10 days.
    expect(item.projection).toEqual({
      date: addDays(today, 10),
      basis: "hours",
      overdue: false,
    });
    expect(item.note).toMatch(/9 flights over 90 days/);
  });
  it("lists usage-only items without history as unprojected", () => {
    const s = state([]);
    const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
    s.inspections = [
      inspection({ dueSeconds: totalSeconds(a) + 2 * H }),
      inspection({
        dueSeconds: totalSeconds(a) + 2 * H,
        dueDate: "2027-01-31",
      }),
    ];
    const items = forecast(s, today);
    expect(items[0].projection?.basis).toBe("calendar");
    expect(items[1].projection).toBeUndefined();
    expect(items[1].note).toMatch(/No accepted flights/);
  });
  it("projects cycles-only inspections and skips archived or limitless ones", () => {
    const s = state();
    const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
    s.inspections = [
      inspection({ dueCycles: a.cycles + 1 }),
      inspection({ dueCycles: a.cycles + 1, archived: true }),
      inspection({}),
    ];
    const items = forecast(s, today);
    expect(items).toHaveLength(1);
    expect(items[0].projection).toEqual({
      date: addDays(today, 10),
      basis: "cycles",
      overdue: false,
    });
  });
  const component = (installed: boolean): Component => ({
    uuid: "c1",
    version: 1,
    kind: "component",
    aircraftUuid: installed ? aircraftUuid : "",
    componentType: "Magneto",
    partNumber: "M-1",
    serial: "7",
    manufacturer: "",
    notes: "",
    installed,
    installedSeconds: totalSeconds(aircraft()),
    installedCycles: 0,
    trackTime: true,
    trackCycles: false,
    trackCalendar: false,
    timeSinceNew: 0,
    timeSinceOverhaul: 0,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
  });
  const requirement: ComponentRequirement = {
    uuid: "r1",
    version: 1,
    kind: "componentRequirement",
    componentUuid: "c1",
    aircraftUuid,
    requirementType: "Overhaul Requirement",
    description: "Overhaul",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSO",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    dueSeconds: 4 * H,
    warningCalendarMonths: 0,
    warningSeconds: 0,
    warningCycles: 0,
  };
  it("projects installed components but not inventory components", () => {
    const s = state();
    s.management = [component(true), requirement];
    expect(forecast(s, today)[0].projection?.date).toBe(addDays(today, 20));
    s.management = [component(false), requirement];
    const [stored] = forecast(s, today);
    expect(stored.aircraftUuid).toBeUndefined();
    expect(stored.projection).toBeUndefined();
    expect(stored.note).toMatch(/inventory/);
    s.management = [
      component(false),
      { ...requirement, dueDate: "2027-03-01" },
    ];
    expect(forecast(s, today)[0].projection?.basis).toBe("calendar");
  });
  it("projects AD task hours and skips complied tasks", () => {
    const s = state();
    const r = blankAD(aircraftUuid);
    const current = adCounters(s, r)!;
    r.applicability = "Applicable";
    r.tasks = [
      {
        ...blankADTask(),
        intervalHours: 100,
        recurrence: "Recurring",
        dueHours: current.hours + 1,
      },
    ];
    s.airworthiness = [r];
    const [item] = forecast(s, today);
    expect(item.kind).toBe("ad");
    expect(item.projection).toEqual({
      date: addDays(today, 5),
      basis: "hours",
      overdue: false,
    });
  });
});

it("groups dates by Monday week", () => {
  expect(weekOf("2026-10-30")).toBe("2026-10-26");
  expect(weekOf("2026-10-26")).toBe("2026-10-26");
  expect(weekOf("2026-11-01")).toBe("2026-10-26");
});
