/**
 * Responsibility: Pins the owner's due list: what it includes, its order, the
 *   remaining text and the counts.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/ownerDue.ts, airworthiness.ts, model.ts;
 *   src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask } from "./airworthiness";
import { totalSeconds, type Snapshot } from "./model";
import { ownerDueCounts, ownerDueItems } from "./ownerDue";

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

it("measures component inspections on its date, not the clock's", () => {
  const { s, a } = owned();
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

it("still throws when a component inspection's usage cannot be computed", () => {
  // Characterizes current behaviour: only a missing component is listed for
  // review; the component rules' other refusals still reach the caller.
  const { s, a } = owned();
  s.inspections[0].componentUuid = "pump";
  expect(() => ownerDueItems(s, a, today)).toThrow(
    "Collective component tracking requires a helicopter collective hourmeter reading.",
  );
});
