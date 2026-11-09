/**
 * Responsibility: Pins utilization windows and notes, due-date projection,
 *   remaining text, and the forecast's items, order and failure notes.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/forecast.ts, ./airworthiness, ./components,
 *   ./model, src/data/demo.ts (seed), tests/fixtures/dueFleet.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DUE_FLEET_TODAY,
  dueFleet,
  withoutMeterReading,
} from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask, adCounters } from "./airworthiness";
import type { Component, ComponentRequirement } from "./components";
import {
  totalSeconds,
  type Flight,
  type Inspection,
  type Snapshot,
} from "./model";
import {
  addDays,
  daysBetween,
  forecast,
  inspectionProjections,
  projectDue,
  remainingText,
  utilization,
  weekOf,
} from "./forecast";

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
    expect(u.note).toBe("Based on 9 flights over 90 days (last 90 days).");
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
    expect(u.note).toBe(
      "Low confidence: based on all history, 2 flights over 1 day; the last 90 days had too little data.",
    );
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
  it("stops projecting beyond a century", () => {
    const perDay = { secondsPerDay: H };
    expect(projectDue({ seconds: 36500 * H }, perDay, today)?.date).toBe(
      addDays(today, 36500),
    );
    expect(projectDue({ seconds: 36501 * H }, perDay, today)).toBeUndefined();
  });
});

describe("remainingText and daysBetween", () => {
  it("joins the limits that are set, marking negative ones overdue", () => {
    expect(
      remainingText({ seconds: 1.5 * H, cycles: -3, dueDate: "2027-01-31" }),
    ).toBe("1.5 h · 3 cycles overdue · due 2027-01-31");
    expect(remainingText({ seconds: -H, landings: 4 })).toBe(
      "1.0 h overdue · 4 landings",
    );
    expect(remainingText({})).toBe("");
  });
  it("counts whole days, negative when the end comes first", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
    expect(daysBetween("2026-10-31", "2026-10-01")).toBe(-30);
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
  it("lists a requirement whose totals cannot be read, with the reason", () => {
    const s = state();
    const installed = component(true);
    installed.installedSeconds = totalSeconds(aircraft()) + H;
    s.management = [installed, requirement];
    const [item] = forecast(s, today);
    expect(item).toMatchObject({ key: "r1", status: "unknown", remaining: "" });
    expect(item.projection).toBeUndefined();
    expect(item.note).toBe(
      "Aircraft readings or date precede the installation baseline.",
    );
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

describe("forecast order and inspection hints", () => {
  it("sorts by projected date, then title, with unprojected items last", () => {
    const s = state();
    const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
    const due = totalSeconds(a) + 2 * H;
    s.inspections = [
      inspection({ reference: "Z later", dueDate: "2027-06-01" }),
      inspection({ reference: "B", dueSeconds: due }),
      inspection({ reference: "A", dueSeconds: due }),
      inspection({ reference: "Overdue", dueDate: "2026-10-01" }),
    ];
    expect(forecast(s, today).map((i) => i.title)).toEqual([
      "Overdue",
      "A",
      "B",
      "Z later",
    ]);
    s.flights = [];
    expect(forecast(s, today).map((i) => i.title)).toEqual([
      "Overdue",
      "Z later",
      "A",
      "B",
    ]);
  });
  it("hints only upcoming inspection projections", () => {
    const s = state();
    const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
    const upcoming = inspection({ dueSeconds: totalSeconds(a) + 2 * H });
    s.inspections = [
      upcoming,
      inspection({ dueDate: "2026-10-01" }),
      inspection({ dueCycles: a.cycles + 1 }),
    ];
    s.flights = steady.map((f) => ({ ...f, cycles: 0 }));
    expect(inspectionProjections(s, today)).toEqual(
      new Map([[upcoming.uuid, addDays(today, 10)]]),
    );
  });
});

it("groups dates by Monday week", () => {
  expect(weekOf("2026-10-30")).toBe("2026-10-26");
  expect(weekOf("2026-10-26")).toBe("2026-10-26");
  expect(weekOf("2026-11-01")).toBe("2026-10-26");
});

describe("forecast on the due fleet", () => {
  // Characterizes current behaviour: inventory requirements and ADs on a
  // removed component list without an aircraft; an AD awaiting review lists.
  it("lists each item with its status, remaining text, projection and note", () => {
    const { s } = dueFleet();
    const rows = forecast(s, DUE_FLEET_TODAY).map((x) =>
      [
        x.key,
        x.aircraftUuid ?? "inventory",
        x.title,
        x.status,
        x.remaining,
        x.projection &&
          `${x.projection.date} ${x.projection.basis} ${x.projection.overdue}`,
        x.note,
      ].join(" | "),
    );
    expect(rows).toStrictEqual(DUE_FLEET_FORECAST);
  });

  it("measures a component inspection's counters on the forecast date", () => {
    const { s } = dueFleet();
    const gear = s.management!.find((r) => r.uuid === "gear")!;
    Object.assign(gear, { installedDate: "2099-01-01" });
    expect(
      forecast(s, "2099-06-01").find((x) => x.key === "i-gear"),
    ).toMatchObject({ status: "scheduled", remaining: "110.0 h" });
  });

  // Characterizes current behaviour: an AD action whose counter is
  // unavailable has nothing to project and is left out, as ad-counter is.
  it("lists a passed AD due date on an aircraft without a meter reading", () => {
    const { s, c } = dueFleet();
    withoutMeterReading(s, c);
    const rows = forecast(s, DUE_FLEET_TODAY)
      .filter((x) => x.aircraftUuid === c.uuid)
      .map((x) => `${x.key} | ${x.status} | ${x.remaining}`);
    expect(rows).toStrictEqual([
      "ad-unread-late:ad-unread-late/monthly-2020-01-01 | Overdue | due 2020-01-01",
      "i-calendar-unread | overdue | due 2020-01-01",
      "i-collective | unknown | ",
    ]);
  });
});

const NO_FLIGHTS = "No accepted flights recorded for this aircraft.";
const NOT_PROJECTED = `${NO_FLIGHTS} Usage limits are not projected.`;
const DUE_FLEET_FORECAST = [
  `ad-b:ad-b/monthly-2020-01-01 | demo-208 | AD AD-B | Overdue | due 2020-01-01 | 2026-10-30 calendar true | ${NO_FLIGHTS}`,
  `ad-overdue:ad-overdue/monthly-2020-01-01 | demo-206 | AD AD-OVERDUE | Overdue | due 2020-01-01 | 2026-10-30 calendar true | ${NO_FLIGHTS}`,
  `i-late | demo-206 | i-late | overdue | due 2026-10-01 | 2026-10-30 calendar true | ${NO_FLIGHTS}`,
  `i-other | demo-208 | i-other | overdue | due 2026-01-01 | 2026-10-30 calendar true | ${NO_FLIGHTS}`,
  `i-today | demo-206 | i-today | due-soon | due 2026-10-30 | 2026-10-30 calendar false | ${NO_FLIGHTS}`,
  `i-zero | demo-206 | i-zero | overdue | 0.0 h | 2026-10-30 hours true | ${NOT_PROJECTED}`,
  `r-b | demo-208 | Type b-pump PN-b-pump S/N SN-b-pump | Due now | 0.0 h | 2026-10-30 hours true | ${NOT_PROJECTED}`,
  `r-now | demo-206 | Type pump PN-pump S/N SN-pump | Due now | 0.0 h | 2026-10-30 hours true | ${NOT_PROJECTED}`,
  `r-today | demo-206 | Type pump PN-pump S/N SN-pump | Due soon | due 2026-10-30 | 2026-10-30 calendar false | ${NO_FLIGHTS}`,
  "r-removed | inventory | Type removed PN-removed S/N SN-removed | Tracked | due 2026-11-15 | 2026-11-15 calendar false | Calendar limit only.",
  `i-ok | demo-206 | i-ok | scheduled | due 2027-06-01 | 2027-06-01 calendar false | ${NO_FLIGHTS}`,
  `ad-review:ad-review/monthly-2030-01-01 | demo-206 | AD AD-REVIEW | Scheduled | due 2030-01-01 | 2030-01-01 calendar false | ${NO_FLIGHTS}`,
  "ad-removed:ad-removed/hourly-300 | inventory | AD AD-REMOVED | Scheduled | 200.0 h |  | Held in inventory; usage limits do not advance.",
  `ad-soon:ad-soon/hourly-2351.2 | demo-206 | AD AD-SOON | Due soon | 10.0 h |  | ${NOT_PROJECTED}`,
  "i-collective | demo-182 | i-collective | unknown |  |  | Collective component tracking requires a helicopter collective hourmeter reading.",
  `i-cycles | demo-206 | i-cycles | due-soon | 5 cycles |  | ${NOT_PROJECTED}`,
  `i-gear | demo-206 | i-gear | scheduled | 110.0 h |  | ${NOT_PROJECTED}`,
  "i-missing | demo-206 | i-missing | unknown |  |  | Inspection component not found.",
  "r-early | demo-206 | Type early PN-early S/N SN-early | unknown |  |  | Aircraft readings or date precede the installation baseline.",
  `r-tracked | demo-206 | Type pump PN-pump S/N SN-pump | Tracked | 500 cycles |  | ${NOT_PROJECTED}`,
];
