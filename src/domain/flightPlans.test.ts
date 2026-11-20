/**
 * Responsibility: Pins ICAO plan import, saving and copying plans with their
 *   change-log entries, each aircraft's queue, and the queue's projection
 *   onto due items.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightPlans.ts, pdf/icao.ts, model.ts,
 *   components.ts, programs.ts, rejection.ts, src/data/demo.ts and
 *   tests/fixtures (icao-text.json, the due fleet).
 */
import { describe, it, expect } from "vitest";
import { dueFleet, withoutMeterReading } from "../../tests/fixtures/dueFleet";
import items from "../../tests/fixtures/icao-text.json";
import { parseIcao } from "./pdf/icao";
import { demoSnapshot } from "../data/demo";
import {
  FLIGHT_RULE_OPTIONS,
  durationLabel,
  flightPlanSchema,
  projectQueue,
  queuedPlans,
  saveFlightPlan,
  validatePlanFlight,
  type FlightPlan,
  type PlanCommand,
} from "./flightPlans";
import { Rejection } from "./rejection";
import { totalSeconds } from "./model";
import { componentSchema, requirementSchema } from "./components";
import { scopedSnapshot } from "./programs";
const draft = () =>
  flightPlanSchema.parse({
    ...parseIcao(items),
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid: demoSnapshot().aircraft[0].uuid,
    durationMinutes: 293,
    cycles: 1,
    landings: 1,
    sourceName: "test.pdf",
    sourceHash: "a".repeat(64),
    createdAt: 0,
    status: "proposed",
  });
describe("ICAO import and flight queue", () => {
  it("copies a removed plan independently while preserving PDF duplicate protection", () => {
    const s = demoSnapshot();
    const original = saveFlightPlan(s, { plan: draft(), baseVersion: 0 });
    const copy = saveFlightPlan(s, {
      plan: {
        ...original,
        uuid: crypto.randomUUID(),
        copiedFromUuid: original.uuid,
        version: 0,
        departureAt: "2026-11-01T12:00:00Z",
        cycles: 2,
      },
      baseVersion: 0,
    });
    expect(copy.uuid).not.toBe(original.uuid);
    expect(copy.version).toBe(1);
    expect(s.flightPlans?.find((p) => p.uuid === original.uuid)).toEqual(
      original,
    );
    expect(() => saveFlightPlan(s, { plan: draft(), baseVersion: 0 })).toThrow(
      "already been imported",
    );
    const removed = saveFlightPlan(s, {
      plan: { ...copy, status: "cancelled" },
      baseVersion: 1,
    });
    const next = saveFlightPlan(s, {
      plan: {
        ...removed,
        uuid: crypto.randomUUID(),
        copiedFromUuid: removed.uuid,
        status: "proposed",
        version: 0,
      },
      baseVersion: 0,
    });
    expect(next.status).toBe("proposed");
    expect(next.cycles).toBe(2);
    expect(() =>
      saveFlightPlan(s, {
        plan: {
          ...next,
          uuid: crypto.randomUUID(),
          copiedFromUuid: crypto.randomUUID(),
        },
        baseVersion: 0,
      }),
    ).toThrow("unavailable");
  });

  it("extracts split characters, wrapped route and duration independently of endurance", () => {
    expect(parseIcao(items)).toMatchObject({
      registration: "N626KB",
      aircraftType: "C441",
      flightRules: "I",
      flightType: "G",
      departureAt: "2026-09-30T22:05:00Z",
      origin: "MZBZ",
      destination: "KCHA",
      alternate: "KRZR",
      durationMinutes: 293,
      enduranceMinutes: 336,
      personsOnBoard: 1,
      speed: "N0255",
      level: "F270",
      route: "DCT BZE R899 CTM UJ26 MID UL209 KEHLI A770 LEV DCT",
      pilotText: "Demo Pilot",
    });
    expect(() => parseIcao([])).toThrow("not the supported");
    const missing = items.filter(
      (i) => !(i.x > 230 && i.x < 311 && i.y > 425 && i.y < 437),
    );
    expect(parseIcao(missing).durationMinutes).toBeUndefined();
  });
  it("sums minutes exactly and checks hours, cycles and end-of-month dates across flights", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    a.operationalStatus = "airworthy";
    s.discrepancies = [];
    s.management = [];
    const p = draft();
    p.departureAt = "2026-09-30T10:00:00Z";
    s.flightPlans = [
      p,
      {
        ...p,
        uuid: crypto.randomUUID(),
        sourceHash: "b".repeat(64),
        departureAt: "2026-10-01T10:00:00Z",
      },
    ];
    s.inspections = [
      {
        uuid: "hours",
        aircraftUuid: a.uuid,
        reference: "HOURS",
        description: "",
        dueSeconds: totalSeconds(a) + 8 * 3600,
      },
      {
        uuid: "cycles",
        aircraftUuid: a.uuid,
        reference: "CYCLES",
        description: "",
        dueCycles: a.cycles + 2,
      },
      {
        uuid: "calendar",
        aircraftUuid: a.uuid,
        reference: "CALENDAR",
        description: "",
        dueDate: "2026-09-30",
      },
    ];
    const result = projectQueue(s, a.uuid);
    expect(result[1].minutes).toBe(586);
    expect(result[1].cycles).toBe(2);
    expect(result[0].flags).not.toContain(
      "CALENDAR: Due before further Flight",
    );
    expect(result[1].flags).toEqual(
      expect.arrayContaining([
        "HOURS: Due before further Flight",
        "CYCLES: due by flight end",
        "CALENDAR: Due before further Flight",
      ]),
    );
    expect(result[1].totalSeconds).toBe(totalSeconds(a) + 586 * 60);
    expect(s.aircraft[0]).toEqual(a);
    s.flightPlans[1].status = "cancelled";
    expect(projectQueue(s, a.uuid)).toHaveLength(1);
  });
  it("flags the first flight after the recurring calendar deadline, including midnight rollover", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    s.inspections = [
      {
        uuid: "phase-2",
        aircraftUuid: a.uuid,
        reference: "Phase 2",
        description: "",
        lastDate: "2025-12-12",
        intervalMonths: 12,
        dueDate: "2027-01-31",
      },
    ];
    const p = {
      ...draft(),
      departureAt: "2026-12-31T10:00:00Z",
      durationMinutes: 60,
    };
    s.flightPlans = [p];
    expect(projectQueue(s, a.uuid)[0].flags).not.toContain(
      "Phase 2: Due before further Flight",
    );
    p.departureAt = "2026-12-31T23:30:00Z";
    expect(projectQueue(s, a.uuid)[0].flags).toContain(
      "Phase 2: Due before further Flight",
    );
    p.departureAt = "2027-01-01T10:00:00Z";
    expect(projectQueue(s, a.uuid)[0].flags).toContain(
      "Phase 2: Due before further Flight",
    );
  });
  it.each([-60, 0, 60, 120])(
    "flags reached or exceeded time limits (%s seconds remaining)",
    (remaining) => {
      const s = demoSnapshot(),
        a = s.aircraft[0];
      s.inspections = [
        {
          uuid: "hours",
          aircraftUuid: a.uuid,
          reference: "HOURS",
          description: "",
          dueSeconds: totalSeconds(a) + remaining,
        },
      ];
      s.flightPlans = [{ ...draft(), durationMinutes: 1 }];
      const flags = projectQueue(s, a.uuid)[0].flags;
      if (remaining <= 60)
        expect(flags).toContain("HOURS: Due before further Flight");
      else expect(flags).not.toContain("HOURS: Due before further Flight");
    },
  );
  it("projects installed component time and cycles using aircraft total time, including tach adjustment", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    a.meter = "tach";
    a.adjustmentSeconds = 50 * 3600;
    const c = componentSchema.parse({
      uuid: "pump",
      kind: "component",
      version: 1,
      aircraftUuid: a.uuid,
      componentType: "Pump",
      partNumber: "PN",
      serial: "SN",
      manufacturer: "",
      notes: "",
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
      installed: true,
      installedDate: "2026-01-01",
      installedSeconds: totalSeconds(a),
      installedCycles: a.cycles,
      timeSinceNew: 100 * 3600,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 20,
      serviceDaysBase: 0,
    });
    const r = requirementSchema.parse({
      uuid: "pump-life",
      kind: "componentRequirement",
      version: 1,
      componentUuid: c.uuid,
      aircraftUuid: a.uuid,
      requirementType: "Life Limits",
      description: "Life limit",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      dueSeconds: 108 * 3600,
      dueCycles: 22,
      warningCalendarMonths: 0,
      warningSeconds: 0,
      warningCycles: 0,
    });
    s.management = [c, r];
    const p = draft();
    s.flightPlans = [
      p,
      { ...p, uuid: crypto.randomUUID(), departureAt: "2026-10-01T22:05:00Z" },
    ];
    const result = projectQueue(s, a.uuid);
    expect(result[0].flags.some((f) => f.includes("Pump"))).toBe(false);
    expect(result[1].flags).toContain("Pump / Life limit: Past due");
    expect(result[1].totalSeconds).toBe(totalSeconds(a) + 586 * 60);
    c.installed = false;
    expect(
      projectQueue(s, a.uuid)[1].flags.some((f) => f.includes("Pump")),
    ).toBe(false);
  });
  it("rejects duplicate PDFs, stale edits and cross-program plans", () => {
    const s = demoSnapshot();
    const p = draft();
    const saved = saveFlightPlan(s, { plan: p, baseVersion: 0 });
    expect(() =>
      saveFlightPlan(s, {
        plan: { ...p, uuid: crypto.randomUUID() },
        baseVersion: 0,
      }),
    ).toThrow("already been imported");
    expect(() => saveFlightPlan(s, { plan: saved, baseVersion: 0 })).toThrow(
      "Plan changed",
    );
    s.aircraft[0].programUuid = "other";
    expect(scopedSnapshot(s).flightPlans).toHaveLength(0);
    expect(() => saveFlightPlan(s, { plan: saved, baseVersion: 1 })).toThrow(
      "access denied",
    );
  });
  it("records plan.saved, then plan.cancelled, with the plan before and after", () => {
    const s = demoSnapshot();
    const logged = s.audit.length;
    const saved = saveFlightPlan(s, { plan: draft(), baseVersion: 0 });
    const cancelled = saveFlightPlan(s, {
      plan: { ...saved, status: "cancelled" },
      baseVersion: 1,
    });
    const entry = (action: string, before: unknown, after: FlightPlan) => ({
      uuid: expect.any(String),
      programUuid: s.aircraft[0].programUuid,
      actorId: s.user.id,
      at: expect.any(Number),
      action,
      entityUuid: saved.uuid,
      aircraftUuid: saved.aircraftUuid,
      before: before && JSON.stringify(before),
      after: JSON.stringify(after),
    });
    expect(s.audit).toHaveLength(logged + 2);
    expect(s.audit.slice(0, 2)).toEqual([
      entry("plan.cancelled", saved, cancelled),
      entry("plan.saved", undefined, saved),
    ]);
  });
  it("keeps held-flight estimates until accepted and prevents double logging", () => {
    const s = demoSnapshot(),
      p = draft();
    s.flightPlans = [p];
    const flight = {
      ...s.flights[0],
      flightPlanUuid: p.uuid,
      aircraftUuid: p.aircraftUuid,
      status: "review" as const,
    };
    s.flights = [flight];
    expect(projectQueue(s, p.aircraftUuid)).toHaveLength(1);
    expect(() => validatePlanFlight(s, flight)).toThrow(
      "already has a logged flight",
    );
    s.flights[0].status = "accepted";
    expect(projectQueue(s, p.aircraftUuid)).toHaveLength(0);
    s.flights[0].status = "rejected";
    expect(() => validatePlanFlight(s, flight)).not.toThrow();
    expect(projectQueue(s, p.aircraftUuid)).toHaveLength(1);
  });
});

it("projects cumulative planned landings into landing-based inspection alerts", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.inspections = [
    {
      uuid: "landing-limit",
      aircraftUuid: a.uuid,
      reference: "Phase 34",
      description: "500-landing inspection",
      dueLandings: a.landings + 50,
    },
  ];
  const plan = draft();
  s.flightPlans = [
    { ...plan, landings: 25, cycles: 0, departureAt: "2026-11-01T12:00:00Z" },
    {
      ...plan,
      uuid: crypto.randomUUID(),
      landings: 25,
      cycles: 0,
      departureAt: "2026-11-02T12:00:00Z",
    },
  ];
  const projected = projectQueue(s, a.uuid);
  expect(projected[0].flags.some((f) => f.startsWith("Phase 34:"))).toBe(false);
  expect(projected[1].flags).toContain("Phase 34: due by flight end");
  expect(a.landings).toBe(s.aircraft[0].landings);
});

function refusal(s: ReturnType<typeof demoSnapshot>, command: PlanCommand) {
  try {
    saveFlightPlan(s, command);
  } catch (error) {
    return [error instanceof Rejection, (error as Error).message];
  }
  return [false, "saved"];
}

describe("plan refusals and queue order", () => {
  it("refuses a save in check order, each as a Rejection", () => {
    const s = demoSnapshot();
    const [a, b] = s.aircraft;
    const original = saveFlightPlan(s, { plan: draft(), baseVersion: 0 });
    const copy: FlightPlan = {
      ...original,
      uuid: crypto.randomUUID(),
      version: 0,
      copiedFromUuid: crypto.randomUUID(),
      sourceHash: "c".repeat(64),
    };
    s.aircraft[0] = { ...a, programUuid: "other" };
    expect(refusal(s, { plan: copy, baseVersion: 1 })).toEqual([
      true,
      "Flight Program access denied.",
    ]);
    s.aircraft[0] = a;
    expect(
      refusal(s, {
        plan: { ...original, aircraftUuid: b.uuid },
        baseVersion: 1,
      }),
    ).toEqual([true, "An existing plan cannot change aircraft."]);
    expect(refusal(s, { plan: copy, baseVersion: 1 })).toEqual([
      true,
      "Plan changed. Reopen it before saving.",
    ]);
    expect(
      refusal(s, {
        plan: { ...original, copiedFromUuid: copy.copiedFromUuid },
        baseVersion: 1,
      }),
    ).toEqual([true, "A plan's copy source cannot change."]);
    expect(refusal(s, { plan: copy, baseVersion: 0 })).toEqual([
      true,
      "The original flight plan is unavailable.",
    ]);
    copy.copiedFromUuid = original.uuid;
    expect(refusal(s, { plan: copy, baseVersion: 0 })).toEqual([
      true,
      "The copied plan must retain its source document.",
    ]);
    s.flights = [{ ...s.flights[0], flightPlanUuid: original.uuid }];
    expect(refusal(s, { plan: original, baseVersion: 1 })).toEqual([
      true,
      "This plan already has a logged flight or a flight awaiting review.",
    ]);
    const reimport = { ...original, uuid: crypto.randomUUID(), version: 0 };
    expect(refusal(s, { plan: reimport, baseVersion: 0 })).toEqual([
      true,
      "This PDF has already been imported for this aircraft.",
    ]);
    s.flights = [];
    saveFlightPlan(s, {
      plan: { ...original, status: "cancelled" },
      baseVersion: 1,
    });
    expect(refusal(s, { plan: reimport, baseVersion: 0 })).toEqual([
      false,
      "saved",
    ]);
  });
  it("refuses a flight on a cancelled plan or another aircraft's plan", () => {
    const s = demoSnapshot();
    const plan = draft();
    s.flightPlans = [{ ...plan, status: "cancelled" }];
    const unavailable = () =>
      validatePlanFlight(s, {
        flightPlanUuid: plan.uuid,
        aircraftUuid: plan.aircraftUuid,
      });
    expect(unavailable).toThrow(Rejection);
    expect(unavailable).toThrow(
      Error("Flight plan is unavailable for this aircraft."),
    );
    s.flightPlans = [plan];
    expect(() =>
      validatePlanFlight(s, {
        flightPlanUuid: plan.uuid,
        aircraftUuid: s.aircraft[1].uuid,
      }),
    ).toThrow("unavailable");
  });
  it("orders the queue by departure, then creation, then uuid", () => {
    const s = demoSnapshot();
    const plan = draft();
    const at = (uuid: string, departureAt: string, createdAt: number) => ({
      ...plan,
      uuid,
      departureAt,
      createdAt,
    });
    s.flightPlans = [
      at("c0000000-0000-4000-8000-000000000000", "2026-10-02T00:00:00Z", 0),
      at("b0000000-0000-4000-8000-000000000000", "2026-10-01T00:00:00Z", 1),
      at("a0000000-0000-4000-8000-000000000000", "2026-10-01T00:00:00Z", 1),
      at("d0000000-0000-4000-8000-000000000000", "2026-10-01T00:00:00Z", 0),
    ];
    expect(queuedPlans(s, plan.aircraftUuid).map((p) => p.uuid[0])).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });
  it("flags a held flight, status and open discrepancies first, and runs every meter", () => {
    const s = demoSnapshot();
    const a = s.aircraft[0];
    a.operationalStatus = "grounded";
    s.inspections = [];
    s.management = [];
    const plan = draft();
    s.flightPlans = [plan];
    s.flights = [
      {
        ...s.flights[0],
        flightPlanUuid: plan.uuid,
        aircraftUuid: a.uuid,
        status: "review",
      },
    ];
    s.discrepancies = [
      { ...s.discrepancies[0], aircraftUuid: a.uuid, description: "Light" },
    ];
    expect(projectQueue(s, a.uuid)[0].flags).toEqual([
      "Logged flight awaiting review; estimate remains in projection until accepted.",
      "Profile status: Grounded",
      "Open discrepancy: Light",
    ]);
    a.meter = "flightTimeLog";
    a.flightTimeLog = true;
    a.currentFlightTimeLog = 3600;
    expect(projectQueue(s, a.uuid)[0].totalSeconds).toBe(
      totalSeconds(a) + plan.durationMinutes * 60,
    );
    expect(durationLabel(293)).toBe("4h 53m");
    expect(durationLabel(5)).toBe("0h 05m");
  });
});

describe("queue flags on the due fleet", () => {
  // Component flags follow component order, so r-early's flag comes after
  // the pump's.
  it("flags inspections, then each component's requirements", () => {
    const { s, a } = dueFleet();
    const early = s.management!.find((r) => r.uuid === "r-early")!;
    Object.assign(early, { dueSeconds: 100 * 3600 });
    s.flightPlans = [
      { ...draft(), departureAt: "2026-10-31T12:00:00Z", durationMinutes: 60 },
    ];
    expect(projectQueue(s, a.uuid)[0].flags).toStrictEqual([
      "Profile status: Unverified",
      "i-late: Due before further Flight",
      "i-today: Due before further Flight",
      "i-zero: Due before further Flight",
      "i-cycles: due-soon",
      ": unknown",
      "i-missing: Inspection component not found.",
      "Type pump / r-now limit: Past due",
      "Type pump / r-today limit: Past due",
      "Type pump / r-landing limit: Set landing baseline",
      "Type early / r-early limit: Due now",
      "Type gear / r-gear-tso limit: Set time baseline",
    ]);
  });

  it("measures a component inspection on the component's hours", () => {
    const { s, a } = dueFleet();
    const gearCheck = s.inspections.find((i) => i.uuid === "i-gear")!;
    s.flightPlans = [{ ...draft(), durationMinutes: 60 }];
    const flagged = () =>
      projectQueue(s, a.uuid)[0].flags.filter((f) => f.startsWith("i-gear"));
    expect(totalSeconds(a)).toBeGreaterThan(210 * 3600);
    expect(flagged()).toEqual([]);
    gearCheck.dueSeconds = 100.5 * 3600;
    expect(flagged()).toEqual(["i-gear: Due before further Flight"]);
  });

  it("flags an inspection it cannot project instead of failing the queue", () => {
    const { s, c } = dueFleet();
    s.flightPlans = [{ ...draft(), aircraftUuid: c.uuid, durationMinutes: 60 }];
    expect(projectQueue(s, c.uuid)[0].flags).toContain(
      "i-collective: Collective component tracking requires a helicopter collective hourmeter reading.",
    );
  });

  it("projects the queue of an aircraft without a meter reading, with no total", () => {
    const { s, c } = dueFleet();
    withoutMeterReading(s, c);
    s.flightPlans = [{ ...draft(), aircraftUuid: c.uuid, durationMinutes: 60 }];
    const [entry] = projectQueue(s, c.uuid);
    expect(entry.minutes).toBe(60);
    expect(entry.totalSeconds).toBeUndefined();
    // RM-66: the calendar-only inspection is flagged although the meter is unread.
    expect(entry.flags).toStrictEqual([
      "Profile status: Unverified",
      "i-collective: Collective component tracking requires a helicopter collective hourmeter reading.",
      "i-calendar-unread: Due before further Flight",
    ]);
  });

  it("flags a requirement it cannot project instead of failing the queue", () => {
    const { s, a } = dueFleet();
    const early = s.management!.find((r) => r.uuid === "early")!;
    Object.assign(early, { installedSeconds: totalSeconds(a) + 7200 });
    s.flightPlans = [{ ...draft(), durationMinutes: 60 }];
    expect(projectQueue(s, a.uuid)[0].flags).toContain(
      "Type early: verify installation baseline for planned date",
    );
  });
});

describe("plan field limits", () => {
  const long = (length: number) => "A".repeat(length);
  const cases: [keyof FlightPlan, unknown, unknown][] = [
    ["origin", long(100), long(101)],
    ["destination", long(100), long(101)],
    ["route", long(5000), long(5001)],
    ["pilotText", long(5000), long(5001)],
    ["durationMinutes", 5999, 6000],
    ["enduranceMinutes", 5999, 6000],
    ["cycles", 1000, 1001],
    ["landings", 1000, 1001],
    ["personsOnBoard", 999, 1000],
  ];

  it.each(cases)(
    "accepts %s at its limit and refuses one past it",
    (key, at, past) => {
      const parses = (value: unknown) =>
        flightPlanSchema.safeParse({ ...draft(), [key]: value }).success;
      expect(parses(at)).toBe(true);
      expect(parses(past)).toBe(false);
    },
  );

  it("accepts exactly the ICAO flight rules the form offers", () => {
    const parses = (flightRules: string) =>
      flightPlanSchema.safeParse({ ...draft(), flightRules }).success;
    expect(FLIGHT_RULE_OPTIONS.map(([rule]) => rule)).toEqual([
      "I",
      "V",
      "Y",
      "Z",
    ]);
    expect(FLIGHT_RULE_OPTIONS.every(([rule]) => parses(rule))).toBe(true);
    expect(parses("X")).toBe(false);
  });
});
