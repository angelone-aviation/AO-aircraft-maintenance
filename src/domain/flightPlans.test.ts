import { describe, it, expect } from "vitest";
import items from "../../tests/fixtures/icao-text.json";
import { parseIcao } from "./pdf/icao";
import { demoSnapshot } from "../data/demo";
import {
  flightPlanSchema,
  projectQueue,
  saveFlightPlan,
  validatePlanFlight,
} from "./flightPlans";
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
