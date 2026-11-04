/**
 * Responsibility: Pins the owner's due list: what it includes, its order, the
 *   remaining text and the counts.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/ownerDue.ts, airworthiness.ts, model.ts,
 *   rejection.ts; src/data/demo.ts (seed), tests/fixtures/dueFleet.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DUE_FLEET_TODAY,
  dueFleet,
  withoutMeterReading,
} from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask } from "./airworthiness";
import { totalSeconds, type Snapshot } from "./model";
import { ownerDueCounts, ownerDueItems } from "./ownerDue";
import { Rejection } from "./rejection";

const today = "2026-10-30";

function owned() {
  const s: Snapshot = {
    ...demoSnapshot(),
    inspections: [],
    management: [],
    airworthiness: [],
  };
  const a = s.aircraft.find((x) => x.uuid === "demo-206")!;
  const inspection = (uuid: string, dueDate?: string) => ({
    uuid,
    aircraftUuid: a.uuid,
    reference: uuid,
    description: "",
    dueDate,
  });
  s.inspections = [
    inspection("ok", "2027-06-01"),
    inspection("soon", "2026-11-09"),
    inspection("late", "2026-10-01"),
    inspection("none"),
  ];
  const ad = (uuid: string, applicability: string, dueDate?: string) => ({
    ...blankAD(a.uuid),
    uuid,
    applicability,
    reviewRequired: false,
    tasks: dueDate ? [{ ...blankADTask(), dueDate }] : [],
    source: { ...blankAD(a.uuid).source, number: uuid, subject: "Subject" },
  });
  s.airworthiness = [
    ad("na", "Not applicable"),
    ad("superseded", "Superseded"),
    ad("open", "Applicable"),
    ad("due", "Applicable", "2026-11-05"),
  ] as Snapshot["airworthiness"];
  // A collective-meter component on an aircraft without that meter.
  s.management = [
    {
      uuid: "pump",
      version: 1,
      kind: "component",
      aircraftUuid: a.uuid,
      componentType: "Pump",
      partNumber: "P",
      serial: "S1",
      manufacturer: "M",
      notes: "",
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
      installed: true,
      installedDate: "2026-01-01",
      installedSeconds: totalSeconds(a),
      installedCycles: a.cycles,
      timeSinceNew: 360000,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 25,
      serviceDaysBase: 30,
      usageMeter: "collective",
    },
    {
      uuid: "limit",
      version: 1,
      kind: "componentRequirement",
      componentUuid: "pump",
      aircraftUuid: a.uuid,
      requirementType: "Life Limits",
      description: "Replace",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      dueDate: "2027-01-01",
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
    },
  ];
  return { s, a };
}

it("lists overdue, due soon, unknown, then ok, leaving out ADs that are not applicable or superseded", () => {
  const { s, a } = owned();
  expect(ownerDueItems(s, a, today).map((i) => [i.uuid, i.status])).toEqual([
    ["late", "overdue"],
    ["soon", "due-soon"],
    ["due", "due-soon"],
    ["none", "unknown"],
    ["limit", "unknown"],
    ["open", "unknown"],
    ["ok", "ok"],
  ]);
});

it("says what remains, Not set without a limit, and Review for a limit it cannot compute", () => {
  const { s, a } = owned();
  const remaining = Object.fromEntries(
    ownerDueItems(s, a, today).map((i) => [i.uuid, i.remaining]),
  );
  expect(remaining).toMatchObject({
    late: "-29 days",
    soon: "10 days",
    none: "Not set",
    limit: "Review",
  });
});

it("counts overdue and due-soon items", () => {
  const { s, a } = owned();
  expect(ownerDueCounts(ownerDueItems(s, a, today))).toEqual({
    overdue: 1,
    dueSoon: 2,
  });
});

it("lists an inspection whose component is missing for review", () => {
  const { s, a } = owned();
  s.inspections[0].componentUuid = "missing";
  expect(ownerDueItems(s, a, today).find((i) => i.uuid === "ok")).toEqual({
    uuid: "ok",
    kind: "Inspection",
    label: "ok",
    status: "unknown",
    remaining: "Review",
  });
});

it("judges ADs on its date, not the clock's", () => {
  const { s, a } = owned();
  const status = (on: string) =>
    ownerDueItems(s, a, on).find((x) => x.uuid === "due")?.status;
  expect(status("2026-09-01")).toBe("ok");
  expect(status(today)).toBe("due-soon");
  expect(status("2026-11-06")).toBe("overdue");
});

it("measures component inspections on its date, not the clock's", () => {
  const { s, a } = owned();
  // On 2099-06-01 the fixture's ADs are overdue and would sort first.
  s.airworthiness = [];
  const gear = Object.assign(structuredClone(s.management![0]), {
    uuid: "gear",
    usageMeter: undefined,
    installedDate: "2099-01-01",
  });
  s.management!.push(gear);
  s.inspections = [
    {
      uuid: "gear-check",
      aircraftUuid: a.uuid,
      reference: "gear-check",
      description: "",
      componentUuid: "gear",
      dueSeconds: 360000 + 36000,
    },
  ];
  expect(ownerDueItems(s, a, "2099-06-01")[0]).toMatchObject({
    uuid: "gear-check",
    remaining: "10.0 h",
  });
});

describe("on the due fleet", () => {
  // Characterizes current behaviour: the rows, text, order and states the
  // owner portal shows, including an AD on a removed component, which the
  // Dispatch gate leaves out.
  it("lists every row of each aircraft, worst first, in record order", () => {
    const { s, a, b } = dueFleet();
    const rows = (x: typeof a) =>
      ownerDueItems(s, x, DUE_FLEET_TODAY).map((i) =>
        Object.values(i).join(" | "),
      );
    expect(rows(a)).toStrictEqual(N206_ROWS);
    expect(rows(b)).toStrictEqual([
      "i-other | Inspection | i-other | overdue | -302 days",
      "r-b | Component | Type b-pump S/N SN-b-pump · r-b limit | overdue | 0.0 h",
      "ad-b | AD | AD AD-B · Subject | overdue | Months remaining (approx.): 81.9 overdue",
    ]);
  });

  it("returns rows with exactly the five owner fields", () => {
    const { s, a } = dueFleet();
    for (const row of ownerDueItems(s, a, DUE_FLEET_TODAY))
      expect(Object.keys(row)).toStrictEqual([
        "uuid",
        "kind",
        "label",
        "status",
        "remaining",
      ]);
  });

  it("throws for the aircraft whose inspection needs a collective meter", () => {
    const { s, c } = dueFleet();
    expect(() => ownerDueItems(s, c, DUE_FLEET_TODAY)).toThrow(
      new Rejection(
        "Collective component tracking requires a helicopter collective hourmeter reading.",
      ),
    );
  });

  it("lists an aircraft without a meter reading, its inspections for review", () => {
    const { s, c } = dueFleet();
    withoutMeterReading(s, c);
    s.inspections = s.inspections.filter((i) => i.aircraftUuid !== c.uuid);
    const rows = ownerDueItems(s, c, DUE_FLEET_TODAY);
    expect(rows.map((i) => Object.values(i).join(" | "))).toStrictEqual([
      "ad-unread-late | AD | AD AD-UNREAD-LATE · Subject | overdue | Hours remaining: Counter unavailable · Months remaining (approx.): 81.9 overdue",
      "ad-unread | AD | AD AD-UNREAD · Subject | unknown | Hours remaining: Counter unavailable",
    ]);
    s.inspections.push({
      uuid: "annual",
      aircraftUuid: c.uuid,
      reference: "Annual",
      description: "",
      dueDate: "2027-01-01",
    });
    expect(ownerDueItems(s, c, DUE_FLEET_TODAY)[1]).toStrictEqual({
      uuid: "annual",
      kind: "Inspection",
      label: "Annual",
      status: "unknown",
      remaining: "Review",
    });
  });
});

const N206_ROWS = [
  "i-late | Inspection | i-late | overdue | -29 days",
  "i-zero | Inspection | i-zero | overdue | 0.0 h",
  "r-now | Component | Type pump S/N SN-pump · r-now limit | overdue | 0.0 h",
  "ad-overdue | AD | AD AD-OVERDUE · Subject | overdue | Months remaining (approx.): 81.9 overdue",
  "i-today | Inspection | i-today | due-soon | 0 days",
  "i-cycles | Inspection | i-cycles | due-soon | 5 cycles",
  "r-today | Component | Type pump S/N SN-pump · r-today limit | due-soon | 0 days",
  "ad-soon | AD | AD AD-SOON · Subject | due-soon | Hours remaining: 10.0",
  "i-none | Inspection | No limit set | unknown | Not set",
  "i-missing | Inspection | i-missing | unknown | Review",
  "r-early | Component | Type early S/N SN-early · r-early limit | unknown | Review",
  "r-landing | Component | Type pump S/N SN-pump · r-landing limit | unknown | Not set",
  "r-gear-tso | Component | Type gear S/N SN-gear · r-gear-tso limit | unknown | Not set",
  "ad-review | AD | AD AD-REVIEW · Subject | unknown | Months remaining (approx.): 38.1",
  "ad-removed | AD | AD AD-REMOVED · Subject | unknown | Hours remaining: 200.0",
  "ad-unset | AD | AD AD-UNSET · Subject | unknown | Not set",
  "ad-counter | AD | AD AD-COUNTER · Subject | unknown | Hours remaining: Counter unavailable",
  "i-ok | Inspection | i-ok | ok | 214 days",
  "i-exempt | Inspection | i-exempt | ok | Not set",
  "i-gear | Inspection | i-gear | ok | 110.0 h",
  "r-tracked | Component | Type pump S/N SN-pump · r-tracked limit | ok | 500 cycles",
  "ad-complied | AD | AD AD-COMPLIED · Subject | ok | Not set",
  "ad-pcw | AD | AD AD-PCW · Subject | ok | Not set",
];

it("still throws when a component inspection's usage cannot be computed", () => {
  // Characterizes current behaviour: only a missing component is listed for
  // review; the component rules' other refusals still reach the caller.
  const { s, a } = owned();
  s.inspections[0].componentUuid = "pump";
  expect(() => ownerDueItems(s, a, today)).toThrow(
    "Collective component tracking requires a helicopter collective hourmeter reading.",
  );
});
