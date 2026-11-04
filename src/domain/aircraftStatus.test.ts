/**
 * Responsibility: Pins aircraft status levels, reasons and their order, and
 *   the dispatch gate's refusals and overrides.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/aircraftStatus.ts, ./airworthiness, ./components,
 *   ./deferrals, ./model, ./rejection, src/data/demo.ts (seed),
 *   tests/fixtures/dueFleet.ts.
 */
import { describe, expect, it } from "vitest";
import { DUE_FLEET_TODAY, dueFleet } from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import {
  aircraftStatus,
  dispatchGate,
  earliestLocalDate,
} from "./aircraftStatus";
import { blankAD, blankADTask } from "./airworthiness";
import { componentSchema, requirementSchema } from "./components";
import { deferDiscrepancy } from "./deferrals";
import { localDate, totalSeconds, type Snapshot } from "./model";
import { Rejection } from "./rejection";

const today = localDate();
const N206 = "demo-206";
function setup() {
  const s = demoSnapshot();
  // Start from a clean, airworthy N206MA.
  s.inspections = s.inspections.filter((i) => i.aircraftUuid !== N206);
  return s;
}
function component(s: Snapshot, dueSeconds: number) {
  const a = s.aircraft[0];
  const c = componentSchema.parse({
    uuid: "pump",
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: "Pump",
    partNumber: "PN",
    serial: "SN1",
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
    dueSeconds,
    warningCalendarMonths: 0,
    warningSeconds: 10 * 3600,
    warningCycles: 0,
  });
  s.management = [c, r];
}
function ad(s: Snapshot, dueDate: string) {
  const r = blankAD(N206);
  r.source.number = "2026-07-01";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [{ ...blankADTask(), description: "Inspect", dueDate }];
  s.airworthiness = [r];
  return r;
}
const addDays = (n: number) =>
  new Date(Date.parse(today + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);

describe("aircraft status", () => {
  it("is airworthy with no findings and ignores non-grounding discrepancies", () => {
    const s = setup();
    s.discrepancies.push({
      uuid: "d1",
      aircraftUuid: N206,
      description: "Seat cushion torn",
      status: "open",
      authorId: s.user.id,
      createdAt: 0,
    });
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "airworthy",
      reasons: [],
    });
  });
  it("reports due-soon items with reasons when nothing grounds", () => {
    const s = demoSnapshot();
    const status = aircraftStatus(s, N206, today);
    expect(status.level).toBe("due-soon");
    expect(status.reasons).toEqual([
      {
        kind: "inspection",
        label: "100-hour inspection due soon",
        entityUuid: "demo-insp-1",
      },
    ]);
  });
  it("grounds on overdue inspections and lists only grounding reasons", () => {
    const s = demoSnapshot();
    s.inspections.push({
      uuid: "late",
      aircraftUuid: N206,
      reference: "Annual",
      description: "",
      dueDate: addDays(-1),
    });
    const status = aircraftStatus(s, N206, today);
    expect(status.level).toBe("grounded");
    expect(status.reasons).toEqual([
      { kind: "inspection", label: "Annual overdue", entityUuid: "late" },
    ]);
    // Archived schedules are ignored.
    s.inspections = s.inspections.map((i) =>
      i.uuid === "late" ? { ...i, archived: true } : i,
    );
    expect(aircraftStatus(s, N206, today).level).toBe("due-soon");
  });
  it("grounds on a past-due installed component and warns when due soon", () => {
    const s = setup();
    component(s, 105 * 3600);
    expect(aircraftStatus(s, N206, today)).toMatchObject({
      level: "due-soon",
      reasons: [{ kind: "component", entityUuid: "pump-life" }],
    });
    component(s, 99 * 3600);
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "grounded",
      reasons: [
        {
          kind: "component",
          label: "Pump S/N SN1: Life limit past due",
          entityUuid: "pump-life",
        },
      ],
    });
    s.management = s.management!.map((r) =>
      r.kind === "component" ? { ...r, installed: false } : r,
    );
    expect(aircraftStatus(s, N206, today).level).toBe("airworthy");
  });
  it("grounds on a component exactly at its limit, like an inspection at 0 h", () => {
    const s = setup();
    component(s, 100 * 3600);
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "grounded",
      reasons: [
        {
          kind: "component",
          label: "Pump S/N SN1: Life limit due now",
          entityUuid: "pump-life",
        },
      ],
    });
    // The dispatch gate follows the aircraft status.
    expect(() => dispatchGate(s, N206, undefined, today)).toThrow(
      "N206MA is grounded: Pump S/N SN1: Life limit due now.",
    );
    expect(
      dispatchGate(s, N206, "Ferry flight to repair shop", today, 7),
    ).toMatchObject({ reason: "Ferry flight to repair shop" });
  });
  it("grounds on an overdue AD task and skips non-applicable ADs", () => {
    const s = setup();
    const r = ad(s, addDays(-1));
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "grounded",
      reasons: [
        { kind: "ad", label: "AD 2026-07-01 overdue", entityUuid: r.uuid },
      ],
    });
    s.airworthiness = [{ ...r, applicability: "Not applicable" }];
    expect(aircraftStatus(s, N206, today).level).toBe("airworthy");
    ad(s, addDays(10));
    expect(aircraftStatus(s, N206, today).level).toBe("due-soon");
  });
  it("grounds on an open grounding discrepancy until resolved or deferred", () => {
    const s = setup();
    s.discrepancies.push({
      uuid: "d1",
      aircraftUuid: N206,
      description: "Alternator inoperative",
      status: "open",
      grounding: true,
      authorId: s.user.id,
      createdAt: 0,
    });
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "grounded",
      reasons: [
        {
          kind: "discrepancy",
          label: "Open discrepancy: Alternator inoperative",
          entityUuid: "d1",
        },
      ],
    });
    const deferred = deferDiscrepancy(s, {
      uuid: "d1",
      deferredOn: today,
      deferral: {
        type: "mel",
        melItem: "24-1",
        category: "C",
        placard: "INOP",
      },
    });
    s.discrepancies = s.discrepancies.map((d) =>
      d.uuid === "d1" ? deferred : d,
    );
    expect(aircraftStatus(s, N206, today).level).toBe("airworthy");
    // Expiring MEL deferrals warn, expired ones ground.
    expect(aircraftStatus(s, N206, addDays(8))).toMatchObject({
      level: "due-soon",
      reasons: [{ kind: "deferral", entityUuid: "d1" }],
    });
    expect(aircraftStatus(s, N206, addDays(10)).level).toBe("due-soon");
    expect(aircraftStatus(s, N206, addDays(11))).toEqual({
      level: "grounded",
      reasons: [
        {
          kind: "deferral",
          label: `MEL 24-1 (Category C) deferral expired ${addDays(10)}`,
          entityUuid: "d1",
        },
      ],
    });
    s.discrepancies = s.discrepancies.map((d) =>
      d.uuid === "d1" ? { ...d, status: "resolved" as const } : d,
    );
    expect(aircraftStatus(s, N206, addDays(11)).level).toBe("airworthy");
  });
  it("grounds when the profile is marked grounded and ranks grounding over due-soon", () => {
    const s = demoSnapshot();
    s.aircraft[0] = { ...s.aircraft[0], operationalStatus: "grounded" };
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "grounded",
      reasons: [
        {
          kind: "profile",
          label: "Marked grounded in the aircraft profile",
          entityUuid: N206,
        },
      ],
    });
  });
  it("rejects unknown aircraft", () => {
    expect(() => aircraftStatus(setup(), "nope", today)).toThrow(
      "Aircraft not found",
    );
    expect(() => aircraftStatus(setup(), "nope", today)).not.toThrow(Rejection);
  });
  it("lists grounding reasons as profile, inspections, components, ADs, then discrepancies", () => {
    const s = setup();
    component(s, 99 * 3600);
    const r = ad(s, addDays(-1));
    s.discrepancies.push({
      uuid: "d1",
      aircraftUuid: N206,
      description: `Alternator ${"x".repeat(80)}`,
      status: "open",
      grounding: true,
      authorId: s.user.id,
      createdAt: 0,
    });
    s.inspections.push({
      uuid: "late",
      aircraftUuid: N206,
      reference: "Annual",
      description: "",
      dueDate: addDays(-1),
    });
    s.aircraft[0] = { ...s.aircraft[0], operationalStatus: "grounded" };
    const { reasons } = aircraftStatus(s, N206, today);
    expect(reasons.map((reason) => reason.entityUuid)).toEqual([
      N206,
      "late",
      "pump-life",
      r.uuid,
      "d1",
    ]);
    expect(reasons[4].label).toBe(
      `Open discrepancy: Alternator ${"x".repeat(66)}…`,
    );
  });
  it("adds no reason for an uncomputable schedule, a removed component's AD or a superseded AD", () => {
    const s = setup();
    s.inspections.push({
      uuid: "bad-date",
      aircraftUuid: N206,
      reference: "Annual",
      description: "",
      lastDate: "2026-02-30",
      intervalMonths: 12,
    });
    component(s, 99 * 3600);
    s.management = s.management!.map((r) =>
      r.kind === "component" ? { ...r, installed: false } : r,
    );
    const onPump = { ...ad(s, addDays(-1)), componentUuid: "pump" };
    const superseded = {
      ...ad(s, addDays(-1)),
      applicability: "Superseded" as const,
    };
    s.airworthiness = [onPump, superseded];
    expect(aircraftStatus(s, N206, today)).toEqual({
      level: "airworthy",
      reasons: [],
    });
  });
  it("flags a deferral as due soon from 3 days before it expires", () => {
    const s = setup();
    s.discrepancies.push({
      uuid: "d1",
      aircraftUuid: N206,
      description: "Light inoperative",
      status: "open",
      authorId: s.user.id,
      createdAt: 0,
      deferral: {
        type: "mel",
        melItem: "33-1",
        category: "C",
        placard: "INOP",
        deferredOn: today,
        deferredAt: 0,
        deferredBy: s.user.id,
        deferredByName: s.user.name,
        expiresOn: addDays(10),
      },
    });
    expect(aircraftStatus(s, N206, addDays(6)).level).toBe("airworthy");
    expect(aircraftStatus(s, N206, addDays(7))).toEqual({
      level: "due-soon",
      reasons: [
        {
          kind: "deferral",
          label: `MEL 33-1 (Category C) deferral expires ${addDays(10)}`,
          entityUuid: "d1",
        },
      ],
    });
  });
});

describe("dispatch gate", () => {
  function grounded() {
    const s = setup();
    s.discrepancies.push({
      uuid: "d1",
      aircraftUuid: N206,
      description: "Alternator inoperative",
      status: "open",
      grounding: true,
      authorId: s.user.id,
      createdAt: 0,
    });
    return s;
  }
  function pilot(s: Snapshot) {
    return {
      ...s,
      user: { ...s.members[1], groupIds: ["demo-pilots"] },
    };
  }
  it("allows airworthy and due-soon aircraft without an override", () => {
    expect(dispatchGate(demoSnapshot(), N206, undefined, today)).toBe(
      undefined,
    );
  });
  it("blocks grounded aircraft with the reasons", () => {
    expect(() => dispatchGate(grounded(), N206, undefined, today)).toThrow(
      "N206MA is grounded: Open discrepancy: Alternator inoperative.",
    );
  });
  it("lets an administrator override with a reason of at least 10 characters", () => {
    const s = grounded();
    expect(() => dispatchGate(s, N206, "too short", today)).toThrow(
      "10–1000 characters",
    );
    expect(
      dispatchGate(s, N206, "  Ferry flight to repair shop  ", today, 42),
    ).toEqual({
      by: "demo-admin",
      name: "Alex Morgan",
      reason: "Ferry flight to repair shop",
      at: 42,
    });
    // An override is unused on an aircraft that is not grounded.
    expect(
      dispatchGate(demoSnapshot(), N206, "Ferry flight to repair shop", today),
    ).toBe(undefined);
  });
  it("rejects overrides from non-administrators, even when not grounded", () => {
    expect(() =>
      dispatchGate(pilot(grounded()), N206, "Ferry flight approved", today),
    ).toThrow("Only a Flight Program administrator");
    expect(() =>
      dispatchGate(pilot(setup()), N206, "Ferry flight approved", today),
    ).toThrow("Only a Flight Program administrator");
    expect(() =>
      dispatchGate(pilot(grounded()), N206, undefined, today),
    ).toThrow("is grounded");
  });
  it("treats program administrators as able to override", () => {
    const s = pilot(grounded());
    s.groups = s.groups.map((g) => ({ ...g, programAdmin: true }));
    expect(dispatchGate(s, N206, "Ferry flight approved", today)?.by).toBe(
      "demo-pilot",
    );
  });
  it("refuses as a Rejection and bounds the reason at 10–1000 characters", () => {
    const refusal = (attempt: () => unknown) => {
      try {
        attempt();
      } catch (error) {
        return error;
      }
    };
    for (const attempt of [
      () => dispatchGate(grounded(), N206, undefined, today),
      () => dispatchGate(grounded(), N206, "x".repeat(1001), today),
      () => dispatchGate(pilot(setup()), N206, "Ferry flight approved", today),
    ])
      expect(refusal(attempt)).toBeInstanceOf(Rejection);
    expect(
      refusal(() => dispatchGate(grounded(), N206, "x".repeat(1001), today)),
    ).toEqual(
      new Rejection("Explain the dispatch override in 10–1000 characters."),
    );
    for (const reason of ["x".repeat(10), "x".repeat(1000)])
      expect(dispatchGate(grounded(), N206, reason, today)?.reason).toBe(
        reason,
      );
    expect(
      refusal(() => dispatchGate(grounded(), N206, "x".repeat(9), today)),
    ).toBeInstanceOf(Rejection);
  });
  it("computes a lenient server date no later than any local date", () => {
    const now = Date.parse("2026-10-30T06:00:00Z");
    expect(earliestLocalDate(now)).toBe("2026-10-29");
  });
});

describe("aircraft status on the due fleet", () => {
  const reasons = (
    s: Snapshot,
    aircraftUuid: string,
    today = DUE_FLEET_TODAY,
  ) => {
    const status = aircraftStatus(s, aircraftUuid, today);
    return [
      status.level,
      ...status.reasons.map((r) => `${r.kind} ${r.entityUuid}: ${r.label}`),
    ];
  };
  const without = (s: Snapshot, uuids: string[]) => {
    const kept = <T extends { uuid: string }>(xs: T[] = []) =>
      xs.filter((x) => !uuids.includes(x.uuid));
    s.inspections = kept(s.inspections);
    s.management = kept(s.management);
    s.airworthiness = kept(s.airworthiness);
  };

  // Characterizes current behaviour: ADs on a removed component and ADs that
  // no longer apply (even awaiting review) add no reason; components list in
  // component order, so r-early follows the pump's limits.
  it("gives the grounding reasons of each aircraft in order", () => {
    const { s, a, b, c } = dueFleet();
    const early = s.management!.find((r) => r.uuid === "early")!;
    Object.assign(early, { installedSeconds: totalSeconds(a) });
    const limit = s.management!.find((r) => r.uuid === "r-early")!;
    Object.assign(limit, { dueSeconds: 100 * 3600 });
    expect(reasons(s, a.uuid)).toStrictEqual([
      "grounded",
      "inspection i-late: i-late overdue",
      "inspection i-zero: i-zero overdue",
      "component r-now: Type pump S/N SN-pump: r-now limit due now",
      "component r-early: Type early S/N SN-early: r-early limit due now",
      "ad ad-overdue: AD AD-OVERDUE overdue",
    ]);
    expect(reasons(s, b.uuid)).toStrictEqual([
      "grounded",
      "inspection i-other: i-other overdue",
      "component r-b: Type b-pump S/N SN-b-pump: r-b limit due now",
      "ad ad-b: AD AD-B overdue",
    ]);
    expect(reasons(s, c.uuid)).toStrictEqual(["airworthy"]);
  });

  it("gives the due-soon reasons once nothing grounds", () => {
    const { s, a } = dueFleet();
    without(s, ["i-late", "i-zero", "r-now", "ad-overdue"]);
    expect(reasons(s, a.uuid)).toStrictEqual([
      "due-soon",
      "inspection i-today: i-today due soon",
      "inspection i-cycles: i-cycles due soon",
      "component r-today: Type pump S/N SN-pump: r-today limit due soon",
      "ad ad-soon: AD AD-SOON due soon",
    ]);
  });

  it("measures a component inspection's counters on the status date", () => {
    const { s, a } = dueFleet();
    s.inspections = s.inspections.filter((i) => i.uuid === "i-gear");
    s.inspections[0].dueSeconds = 100 * 3600;
    s.management = s.management!.filter((r) => r.kind === "component");
    s.airworthiness = [];
    const gear = s.management.find((r) => r.uuid === "gear")!;
    Object.assign(gear, { installedDate: "2099-01-01" });
    expect(reasons(s, a.uuid, "2099-06-01")).toStrictEqual([
      "grounded",
      "inspection i-gear: i-gear overdue",
    ]);
  });
});
