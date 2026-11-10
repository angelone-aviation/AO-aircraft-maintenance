/**
 * Responsibility: Pins that a limit which is reached decides an AD action's,
 *   an inspection's or a component requirement's status before a counter
 *   that cannot be read or a limit that is not set, and that nothing short
 *   of reached is taken from an unreadable counter.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/airworthiness.ts, aircraftStatus.ts, alerts.ts,
 *   dueItems.ts, management.ts, model.ts, src/data/demo.ts and
 *   tests/fixtures/dueFleet.ts (fixtures).
 */
import { describe, expect, it } from "vitest";
import {
  DUE_FLEET_TODAY,
  dueFleet,
  withoutMeterReading,
} from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import { aircraftStatus } from "./aircraftStatus";
import {
  adLimitCounters,
  adStatus,
  adTaskStatus,
  applyADCommand,
  blankAD,
  blankADTask,
  type ADCompliance,
  type ADTask,
} from "./airworthiness";
import { computeAlerts } from "./alerts";
import { dueItems } from "./dueItems";
import { inspectionCounters } from "./management";
import type { Inspection, Snapshot } from "./model";

const HOUR = 3600;
const NOW = Date.parse("2026-11-10T15:00:00Z");

function compliance(taskUuid: string, over: Partial<ADCompliance> = {}) {
  return {
    uuid: crypto.randomUUID(),
    taskUuid,
    date: "2026-11-01",
    hours: null,
    cycles: null,
    method: "Inspected per paragraph (g) at the annual",
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

// "Repeat at each annual inspection": recurring with no fixed interval, so
// the next due is entered by hand after each compliance.
function annualAD(limits: Partial<ADTask> = { dueDate: "2026-11-30" }) {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  Object.assign(s, { inspections: [], management: [], discrepancies: [] });
  a.operationalStatus = "airworthy";
  const r = blankAD(a.uuid);
  r.source = {
    ...r.source,
    number: "2026-20-01",
    subject: "Inspect at each annual inspection",
    recurring: "Yes",
  };
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect the fitting",
      recurrence: "Recurring",
      ...limits,
    },
  ];
  s.airworthiness = [];
  applyADCommand(s, { kind: "save", record: r }, NOW);
  return { s, a, saved: () => s.airworthiness![0] };
}

function comply(s: Snapshot, entry: ADCompliance) {
  const { uuid, version } = s.airworthiness![0];
  applyADCommand(s, { kind: "comply", uuid, version, entry }, NOW);
}

function enterNextDue(s: Snapshot, limits: Partial<ADTask>) {
  const record = structuredClone(s.airworthiness![0]);
  Object.assign(record.tasks[0], limits);
  const reason = "Next due at the 2027 annual";
  applyADCommand(s, { kind: "save", record, reason }, NOW);
}

describe("an AD action that repeats without a fixed interval", () => {
  it("has its satisfied limits cleared by compliance and reads Due not set", () => {
    const { s, saved } = annualAD({
      dueDate: "2026-11-30",
      dueHours: 2400,
      dueCycles: 2000,
      dueLandings: 5000,
    });
    comply(s, compliance(saved().tasks[0].uuid));
    expect(saved().tasks[0]).toMatchObject({
      dueDate: "",
      dueHours: null,
      dueCycles: null,
      dueLandings: null,
    });
    expect(adStatus(s, saved(), "2027-12-01")).toBe("Due not set");
  });

  it("follows a due date entered after compliance through to Overdue", () => {
    const { s, a, saved } = annualAD();
    comply(s, compliance(saved().tasks[0].uuid));
    enterNextDue(s, { dueDate: "2027-11-30" });
    const status = (today: string) =>
      adTaskStatus(s, saved(), saved().tasks[0], today);
    expect(status("2027-06-01")).toBe("Scheduled");
    expect(status("2027-11-30")).toBe("Due soon");
    expect(status("2027-12-01")).toBe("Overdue");
    expect(aircraftStatus(s, a.uuid, "2027-12-01")).toMatchObject({
      level: "grounded",
      reasons: [{ label: "AD 2026-20-01 overdue" }],
    });
    expect(computeAlerts(s, "2027-12-01").map((x) => x.kind)).toContain(
      "ad-overdue",
    );
  });

  it("follows an hours limit entered after compliance", () => {
    const { s, saved } = annualAD();
    comply(s, compliance(saved().tasks[0].uuid));
    const hours = adLimitCounters(s, saved()).hours!;
    enterNextDue(s, { dueHours: hours + 100 });
    expect(adStatus(s, saved(), "2026-11-10")).toBe("Scheduled");
    enterNextDue(s, { dueHours: hours });
    expect(adStatus(s, saved(), "2026-11-10")).toBe("Overdue");
  });

  it("keeps a limit entered after compliance when that compliance is corrected", () => {
    const { s, saved } = annualAD();
    const original = compliance(saved().tasks[0].uuid);
    comply(s, original);
    enterNextDue(s, { dueDate: "2027-11-30" });
    const { uuid, version } = saved();
    const entry = compliance(original.taskUuid, { date: "2026-11-02" });
    applyADCommand(
      s,
      {
        kind: "correct",
        uuid,
        version,
        corrects: original.uuid,
        reason: "Wrong completion date",
        entry,
      },
      NOW,
    );
    expect(saved().tasks[0].dueDate).toBe("2027-11-30");
  });

  it("leaves the limits of a terminated action as recorded", () => {
    const { s, saved } = annualAD();
    comply(s, compliance(saved().tasks[0].uuid, { terminatedBy: "SB 12" }));
    expect(saved().tasks[0].dueDate).toBe("2026-11-30");
    expect(adStatus(s, saved(), "2027-12-01")).toBe("Complied");
  });
});

// The fixture's `ad-counter` is on a component that tracks cycles but not
// time, with an hours limit of 500: its hours counter cannot be read.
function adOnCyclesOnlyComponent(limits: Partial<ADTask>) {
  const { s, a } = dueFleet();
  s.airworthiness = s.airworthiness!.filter((r) => r.uuid === "ad-counter");
  const [ad] = s.airworthiness;
  Object.assign(ad.tasks[0], limits);
  return { s, a, ad };
}

describe("an AD action whose hours counter cannot be read", () => {
  it.each([{ dueCycles: 20 }, { dueLandings: 1 }, { dueDate: "2026-10-29" }])(
    "is Overdue once %o is reached, grounding the aircraft",
    (limits) => {
      const { s, a, ad } = adOnCyclesOnlyComponent(limits);
      expect(adTaskStatus(s, ad, ad.tasks[0], DUE_FLEET_TODAY)).toBe("Overdue");
      expect(
        aircraftStatus(s, a.uuid, DUE_FLEET_TODAY).reasons.map((r) => r.label),
      ).toContain("AD AD-COUNTER overdue");
      expect(computeAlerts(s, DUE_FLEET_TODAY).map((x) => x.kind)).toContain(
        "ad-overdue",
      );
    },
  );

  it("stays Counter unavailable while its other limits are not reached", () => {
    const { s, ad } = adOnCyclesOnlyComponent({
      dueCycles: 21,
      dueDate: DUE_FLEET_TODAY,
    });
    expect(adTaskStatus(s, ad, ad.tasks[0], DUE_FLEET_TODAY)).toBe(
      "Counter unavailable",
    );
  });

  it("reads each counter on its own", () => {
    const { s, a, ad } = adOnCyclesOnlyComponent({});
    expect(adLimitCounters(s, ad, DUE_FLEET_TODAY)).toEqual({
      hours: null,
      cycles: 20,
      landings: a.landings,
    });
    withoutMeterReading(s, a);
    const onAircraft = { ...ad, componentUuid: "" };
    expect(adLimitCounters(s, onAircraft, DUE_FLEET_TODAY)).toEqual({
      hours: null,
      cycles: a.cycles,
      landings: a.landings,
    });
    expect(adLimitCounters(s, ad, DUE_FLEET_TODAY).cycles).toBe(20);
    const unknown = { ...onAircraft, aircraftUuid: "gone" };
    expect(adLimitCounters(s, unknown, DUE_FLEET_TODAY)).toEqual({
      hours: null,
      cycles: null,
      landings: null,
    });
  });
});

// An aircraft whose time source has no reading (only damaged data), holding
// nothing but the records each case adds.
function unreadAircraft() {
  const { s, a } = dueFleet();
  withoutMeterReading(s, a);
  Object.assign(s, { inspections: [], airworthiness: [], management: [] });
  return { s, a, full: dueFleet().s };
}

const levels = (s: Snapshot, uuid: string) =>
  dueItems(s, uuid, DUE_FLEET_TODAY).map((d) => d.level);

describe("on an aircraft whose meter has no reading", () => {
  const annual = (over: Partial<Inspection>): Inspection => ({
    uuid: "i-annual-100",
    aircraftUuid: "",
    reference: "Annual / 100-hour",
    description: "Hours or calendar, whichever first",
    dueSeconds: 5000 * HOUR,
    ...over,
  });

  it("an hours-or-calendar inspection past its date is overdue and grounds", () => {
    const { s, a } = unreadAircraft();
    s.inspections = [annual({ aircraftUuid: a.uuid, dueDate: "2020-01-01" })];
    expect(levels(s, a.uuid)).toEqual(["overdue"]);
    expect(aircraftStatus(s, a.uuid, DUE_FLEET_TODAY)).toMatchObject({
      level: "grounded",
      reasons: [{ label: "Annual / 100-hour overdue" }],
    });
    expect(
      inspectionCounters(s.inspections[0], a, [], DUE_FLEET_TODAY).seconds,
    ).toBeUndefined();
  });

  it.each([{ dueCycles: 0 }, { dueLandings: 0 }])(
    "an hours inspection whose %o limit is reached is overdue",
    (limit) => {
      const { s, a } = unreadAircraft();
      s.inspections = [annual({ aircraftUuid: a.uuid, ...limit })];
      expect(levels(s, a.uuid)).toEqual(["overdue"]);
    },
  );

  it("an hours inspection not yet past its date is never judged on the date alone", () => {
    const { s, a } = unreadAircraft();
    s.inspections = [annual({ aircraftUuid: a.uuid, dueDate: "2027-01-01" })];
    expect(levels(s, a.uuid)).toEqual(["unknown"]);
    expect(() =>
      inspectionCounters(s.inspections[0], a, [], DUE_FLEET_TODAY),
    ).toThrow("Flight time log reading is required.");
  });

  it("a component's inspection past its date is overdue, on the component's cycles", () => {
    const { s, a, full } = unreadAircraft();
    s.management = full.management!.filter((r) => r.uuid === "gear");
    const check = annual({
      aircraftUuid: a.uuid,
      componentUuid: "gear",
      dueDate: "2020-01-01",
    });
    s.inspections = [check];
    expect(levels(s, a.uuid)).toEqual(["overdue"]);
    expect(inspectionCounters(check, a, s.management, DUE_FLEET_TODAY)).toEqual(
      { seconds: undefined, cycles: 20, landings: a.landings },
    );
  });

  it("a component requirement past its date or cycles is past due and grounds", () => {
    const { s, a, full } = unreadAircraft();
    const records = structuredClone(full.management!);
    const keep = (uuid: string, over: object) =>
      Object.assign(
        records.find((r) => r.uuid === uuid)!,
        over,
      );
    s.management = [
      keep("pump", {}),
      keep("r-today", { dueDate: "2020-01-01" }),
      keep("r-tracked", { dueCycles: 20 }),
      keep("r-now", {}),
    ];
    expect(levels(s, a.uuid)).toEqual(["overdue", "overdue", "unknown"]);
    expect(
      aircraftStatus(s, a.uuid, DUE_FLEET_TODAY).reasons.map((r) => r.label),
    ).toEqual([
      "Type pump S/N SN-pump: r-today limit past due",
      "Type pump S/N SN-pump: r-tracked limit due now",
    ]);
  });

  it("a component requirement past its date is past due even when its cycles cannot be read either", () => {
    const { s, a, full } = unreadAircraft();
    const records = structuredClone(full.management!);
    const pump = records.find((r) => r.uuid === "pump")!;
    const limit = records.find((r) => r.uuid === "r-today")!;
    Object.assign(pump, { installedCycles: a.cycles + 1 });
    s.management = [pump, Object.assign(limit, { dueDate: "2020-01-01" })];
    expect(levels(s, a.uuid)).toEqual(["overdue"]);
    Object.assign(limit, { dueDate: "2027-01-01" });
    expect(levels(s, a.uuid)).toEqual(["unknown"]);
  });

  it("an aircraft AD whose landings limit is reached is overdue and grounds", () => {
    const { s, a, full } = unreadAircraft();
    const base = full.airworthiness!.find((r) => r.uuid === "ad-overdue")!;
    const task = {
      ...base.tasks[0],
      dueDate: "",
      intervalDays: null,
      dueHours: 5000,
      dueLandings: a.landings,
    };
    s.airworthiness = [{ ...base, tasks: [task] }];
    expect(levels(s, a.uuid)).toEqual(["overdue"]);
    expect(aircraftStatus(s, a.uuid, DUE_FLEET_TODAY).level).toBe("grounded");
    task.dueLandings = a.landings + 1;
    expect(adStatus(s, s.airworthiness[0], DUE_FLEET_TODAY)).toBe(
      "Counter unavailable",
    );
  });
});
