import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { aircraftStatus, dispatchGate } from "./aircraftStatus";
import { computeAlerts } from "./alerts";
import {
  componentSchema,
  requirementSchema,
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "./components";
import { forecast } from "./forecast";
import { inspectionStatus } from "./maintenance";
import { localDate, totalSeconds, type Snapshot } from "./model";
import { ownerDueItems } from "./ownerDue";
import { maintenancePartsPlans } from "./partsPlanning";

// One rule for every limit: a usage limit (hours, cycles, landings) is
// reached at 0 remaining, because the next flight would exceed it; a calendar
// limit stays valid through the end of its due date.
const today = localDate();
const N206 = "demo-206";
const addDays = (n: number) =>
  new Date(Date.parse(today + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const tenth = 360; // 0.1 h in seconds

function setup() {
  const s = demoSnapshot();
  // Only the record under test may affect N206MA.
  s.inspections = s.inspections.filter((i) => i.aircraftUuid !== N206);
  s.discrepancies = s.discrepancies.filter((d) => d.aircraftUuid !== N206);
  s.airworthiness = [];
  s.management = [];
  return s;
}
const aircraft = (s: Snapshot) => s.aircraft.find((a) => a.uuid === N206)!;

function addComponent(s: Snapshot, limit: Partial<ComponentRequirement>) {
  const a = aircraft(s);
  const c: Component = componentSchema.parse({
    uuid: "prop",
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: "Propeller",
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
  const r: ComponentRequirement = requirementSchema.parse({
    uuid: "prop-life",
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
    warningCalendarMonths: 1,
    warningSeconds: 10 * 3600,
    warningCycles: 10,
    requiredParts: [{ locationUuid: "store", stockUuid: "seal", quantity: 1 }],
    ...limit,
  });
  s.management = [c, r];
  return { c, r, a };
}
function addInspection(
  s: Snapshot,
  limit: { dueSeconds?: number; dueCycles?: number; dueDate?: string },
) {
  s.inspections.push({
    uuid: "annual",
    aircraftUuid: N206,
    reference: "Annual",
    description: "",
    requiredParts: [{ locationUuid: "store", stockUuid: "seal", quantity: 1 }],
    ...limit,
  });
}

/** What every screen that shows the item reports for it. */
function views(s: Snapshot) {
  const level = aircraftStatus(s, N206, today).level;
  let gate: "blocked" | "open";
  try {
    dispatchGate(s, N206, undefined, today);
    gate = "open";
  } catch {
    gate = "blocked";
  }
  const alerts = computeAlerts(s, today)
    .filter((x) => x.aircraftUuid === N206)
    .map((x) => x.kind)
    .sort();
  const owner = ownerDueItems(s, aircraft(s), today).map((x) => x.status);
  const planning = forecast(s, today)
    .filter((x) => x.aircraftUuid === N206)
    .map((x) => !!x.projection?.overdue);
  const partsUpcoming = maintenancePartsPlans(s)
    .filter((p) => p.aircraftUuid === N206)
    .map((p) => p.upcoming);
  return { level, gate, alerts, owner, planning, partsUpcoming };
}
const overdue = (alert: string) => ({
  level: "grounded",
  gate: "blocked",
  alerts: ["aircraft-grounded", alert].sort(),
  owner: ["overdue"],
  planning: [true],
  partsUpcoming: [true],
});
const dueSoon = (alert: string) => ({
  level: "due-soon",
  gate: "open",
  alerts: [alert],
  owner: ["due-soon"],
  planning: [false],
  partsUpcoming: [true],
});

describe("component requirement limits", () => {
  it.each([
    [-1, "Past due", overdue("component-past-due")],
    [0, "Due soon", dueSoon("component-due-soon")],
    [1, "Due soon", dueSoon("component-due-soon")],
  ])(
    "a calendar limit due %i day(s) from today is %s",
    (days, status, expected) => {
      const s = setup();
      const { c, r, a } = addComponent(s, { dueDate: addDays(days) });
      expect(requirementStatus(r, c, a, today).status).toBe(status);
      expect(views(s)).toEqual(expected);
    },
  );
  it.each([
    [-tenth, "Past due", overdue("component-past-due")],
    [0, "Due now", overdue("component-past-due")],
    [tenth, "Due soon", dueSoon("component-due-soon")],
  ])(
    "an hours limit with %i s remaining is %s",
    (remaining, status, expected) => {
      const s = setup();
      const { c, r, a } = addComponent(s, {
        dueSeconds: 100 * 3600 + remaining,
      });
      expect(requirementStatus(r, c, a, today).status).toBe(status);
      expect(views(s)).toEqual(expected);
    },
  );
  it.each([
    ["cycles", { dueCycles: 20 }],
    ["landings", { dueLandings: 0 }],
  ])("a %s limit at 0 remaining is due now and grounds", (_, limit) => {
    const s = setup();
    const a = aircraft(s);
    const { c, r } = addComponent(s, {
      ...limit,
      ...("dueLandings" in limit && {
        dueLandings: a.landings,
        landingReferenceAircraftUuid: a.uuid,
      }),
    });
    expect(requirementStatus(r, c, a, today).status).toBe("Due now");
    expect(views(s)).toEqual(overdue("component-past-due"));
  });
  it("labels a calendar limit due today as due soon in alerts", () => {
    const s = setup();
    addComponent(s, { dueDate: today });
    expect(
      computeAlerts(s, today).find((x) => x.entityUuid === "prop-life"),
    ).toMatchObject({
      severity: "warning",
      title: "Component due soon: Propeller",
    });
  });
});

describe("inspection limits", () => {
  it.each([
    [-1, "overdue", overdue("inspection-overdue")],
    [0, "due-soon", dueSoon("inspection-due-soon")],
    [1, "due-soon", dueSoon("inspection-due-soon")],
  ])(
    "a calendar limit due %i day(s) from today is %s",
    (days, status, expected) => {
      const s = setup();
      addInspection(s, { dueDate: addDays(days) });
      expect(
        inspectionStatus(s.inspections.at(-1)!, aircraft(s), today),
      ).toMatchObject({
        status,
        daysRemaining: days,
      });
      expect(views(s)).toEqual(expected);
    },
  );
  it.each([
    [-tenth, "overdue", overdue("inspection-overdue")],
    [0, "overdue", overdue("inspection-overdue")],
    [tenth, "due-soon", dueSoon("inspection-due-soon")],
  ])(
    "an hours limit with %i s remaining is %s",
    (remaining, status, expected) => {
      const s = setup();
      addInspection(s, { dueSeconds: totalSeconds(aircraft(s)) + remaining });
      expect(
        inspectionStatus(s.inspections.at(-1)!, aircraft(s), today).status,
      ).toBe(status);
      expect(views(s)).toEqual(expected);
    },
  );
  it("a cycles limit at 0 remaining is overdue and grounds", () => {
    const s = setup();
    addInspection(s, { dueCycles: aircraft(s).cycles });
    expect(views(s)).toEqual(overdue("inspection-overdue"));
  });
});
