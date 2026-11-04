/**
 * Responsibility: A fleet whose inspections, component limits and ADs cover
 *   every case the due-list consumers decide differently (T13).
 * Layer: Test. Fixture for vitest suites; never shipped in the build.
 * Dependencies: src/data/demo.ts (seed), src/domain/airworthiness.ts,
 *   components.ts, model.ts and partsRequests.ts.
 *
 * AD dates sit far from any clock, because adStatus judges an AD's actions
 * on the clock's date, not on the `today` a caller passes.
 */
import { demoSnapshot } from "../../src/data/demo";
import {
  blankAD,
  blankADTask,
  type AD,
  type ADTask,
} from "../../src/domain/airworthiness";
import {
  componentSchema,
  requirementSchema,
  type Component,
  type ComponentRequirement,
} from "../../src/domain/components";
import {
  totalSeconds,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "../../src/domain/model";
import {
  partsRequestSchema,
  type PartsRequest,
} from "../../src/domain/partsRequests";

/** The date the fleet is judged on. */
export const DUE_FLEET_TODAY = "2026-10-30";

const HOUR = 3600;

/** A part the planning list counts, for records that carry parts. */
export const DUE_FLEET_PART = {
  stockUuid: "stock",
  locationUuid: "location",
  quantity: 2,
};

/**
 * The fixture fleet. N206 (`a`) holds most cases; N208 (`b`) holds records
 * that N206's lists must leave out; N182 (`c`) holds an inspection whose
 * status throws for want of a collective meter.
 *
 * @returns A fresh snapshot and its three aircraft.
 */
export function dueFleet() {
  const s: Snapshot = { ...demoSnapshot(), discrepancies: [] };
  const [a, b, c] = s.aircraft;
  s.inspections = fleetInspections(a, b, c);
  s.management = fleetRecords(a, b);
  s.airworthiness = fleetADs(a, b);
  s.partsRequests = fleetRequests(s);
  return { s, a, b, c };
}

function fleetInspections(a: Aircraft, b: Aircraft, c: Aircraft) {
  const on = (x: Aircraft, uuid: string, fields: Partial<Inspection>) => ({
    uuid,
    aircraftUuid: x.uuid,
    reference: uuid,
    description: `${uuid} description`,
    ...fields,
  });
  return [
    on(a, "i-late", { dueDate: "2026-10-01" }),
    on(a, "i-today", { dueDate: DUE_FLEET_TODAY }),
    on(a, "i-zero", { dueSeconds: totalSeconds(a), requiredParts: [part()] }),
    on(b, "i-other", { dueDate: "2026-01-01", requiredParts: [part()] }),
    on(a, "i-cycles", { dueCycles: a.cycles + 5 }),
    on(a, "i-ok", { dueDate: "2027-06-01", requiredParts: [part()] }),
    on(a, "i-none", { reference: "", description: "No limit set" }),
    on(a, "i-exempt", { calendarExempt: true }),
    on(a, "i-archived", { dueDate: "2026-01-01", archived: true }),
    on(a, "i-missing", { componentUuid: "missing", dueDate: "2027-01-01" }),
    on(a, "i-gear", { componentUuid: "gear", dueSeconds: 210 * HOUR }),
    on(c, "i-collective", { usageMeter: "collective", dueDate: "2027-01-01" }),
  ];
}

// Requirements are listed out of their components' order, so an order by
// requirement and an order by component differ.
function fleetRecords(a: Aircraft, b: Aircraft) {
  return [
    component(a, "pump", {}),
    component(a, "early", { installedSeconds: totalSeconds(a) + HOUR }),
    component(a, "gear", {}),
    component(a, "cycles-only", { trackTime: false }),
    component(a, "removed", { installed: false }),
    component(b, "b-pump", {}),
    requirement("early", "r-early", { dueSeconds: 300 * HOUR }),
    ...pumpRequirements(),
    requirement("removed", "r-removed", { dueDate: "2026-11-15" }),
    requirement("b-pump", "r-b", { dueSeconds: 100 * HOUR }),
    requirement("gear", "r-gear-tso", { timeBasis: "TSO", dueSeconds: HOUR }),
  ];
}

function pumpRequirements() {
  return [
    requirement("pump", "r-now", {
      dueSeconds: 100 * HOUR,
      requiredParts: [part()],
    }),
    requirement("pump", "r-today", { dueDate: DUE_FLEET_TODAY }),
    requirement("pump", "r-tracked", {
      dueCycles: 520,
      warningCycles: 10,
      requiredParts: [part()],
    }),
    requirement("pump", "r-landing", {
      dueLandings: 3000,
      landingReferenceAircraftUuid: "demo-208",
    }),
  ];
}

function fleetADs(a: Aircraft, b: Aircraft): AD[] {
  const hours = totalSeconds(a) / HOUR;
  return [
    ad(a, "ad-na", { applicability: "Not applicable" }),
    ad(a, "ad-superseded", { applicability: "Superseded" }),
    ad(a, "ad-review", { reviewRequired: true }, [monthly("2030-01-01")]),
    ad(
      a,
      "ad-na-review",
      { applicability: "Not applicable", reviewRequired: true },
      [monthly("2020-01-01")],
    ),
    ad(a, "ad-removed", { componentUuid: "removed" }, [hourly(300)]),
    ad(a, "ad-overdue", {}, [monthly("2020-01-01")]),
    ad(a, "ad-soon", {}, [hourly(hours + 10)]),
    ad(a, "ad-complied", complied(), [oneTime()]),
    ad(a, "ad-pcw", pcw()),
    ad(a, "ad-unset", {}, [task({})]),
    ad(a, "ad-counter", { componentUuid: "cycles-only" }, [hourly(500)]),
    ad(b, "ad-b", {}, [monthly("2020-01-01")]),
    ad(b, "ad-gone", { aircraftUuid: "gone" }, [monthly("2020-01-01")]),
  ];
}

function part() {
  return { ...DUE_FLEET_PART };
}

function component(
  a: Aircraft,
  uuid: string,
  fields: Partial<Component>,
): Component {
  return componentSchema.parse({
    uuid,
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: `Type ${uuid}`,
    partNumber: `PN-${uuid}`,
    serial: `SN-${uuid}`,
    manufacturer: "",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
    timeSinceNew: 100 * HOUR,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 20,
    serviceDaysBase: 0,
    ...fields,
  });
}

function requirement(
  componentUuid: string,
  uuid: string,
  fields: Partial<ComponentRequirement>,
): ComponentRequirement {
  return requirementSchema.parse({
    uuid,
    kind: "componentRequirement",
    version: 1,
    componentUuid,
    aircraftUuid: "",
    requirementType: "Life Limits",
    description: `${uuid} limit`,
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    warningCalendarMonths: 0,
    warningSeconds: 10 * HOUR,
    warningCycles: 0,
    ...fields,
  });
}

function ad(
  a: Aircraft,
  uuid: string,
  fields: Partial<AD>,
  tasks: ADTask[] = [],
): AD {
  const r = blankAD(a.uuid);
  return {
    ...r,
    uuid,
    applicability: "Applicable",
    reviewRequired: false,
    tasks: tasks.map((t) => ({ ...t, uuid: `${uuid}/${t.uuid}` })),
    source: { ...r.source, number: uuid.toUpperCase(), subject: "Subject" },
    ...fields,
  };
}

// AD actions have no parts of their own: only a parts request plans them.
// ad-soon has none, so planning leaves it out.
function fleetRequests(s: Snapshot): PartsRequest[] {
  const planned = (s.airworthiness ?? []).filter((r) => r.uuid !== "ad-soon");
  return planned.flatMap((r) =>
    r.tasks.map((t) =>
      partsRequestSchema.parse({
        uuid: `request-${t.uuid}`,
        version: 1,
        source: { kind: "airworthiness", uuid: t.uuid },
        mode: "parts",
        date: "2026-10-01",
        engineer: "Engineer",
        priority: "P2 Routine",
        requiredBy: "",
        currency: "USD",
        lines: [
          { uuid: "line", partNumber: "PN", description: "Part", quantity: 1 },
        ],
        programUuid: "demo-program",
        aircraftUuid: r.aircraftUuid,
        sourceLabel: r.uuid,
        aircraftRegistration: "",
        aircraftSerial: "",
        aircraftModel: "",
        number: `PR-${t.uuid}`,
        requesterId: "demo-admin",
        createdAt: 0,
        updatedAt: 0,
        cancelled: false,
        reservations: [],
        issues: [],
        history: [],
      }),
    ),
  );
}

function task(fields: Partial<ADTask>): ADTask {
  return { ...blankADTask(), uuid: "task", description: "Inspect", ...fields };
}

function monthly(dueDate: string) {
  return task({ uuid: `monthly-${dueDate}`, dueDate, intervalDays: 30 });
}

function hourly(dueHours: number) {
  return task({ uuid: `hourly-${dueHours}`, dueHours, intervalHours: 100 });
}

function oneTime() {
  return task({
    uuid: "one-time",
    recurrence: "One-time",
    dueDate: "2020-01-01",
  });
}

function complied(): Partial<AD> {
  const entry = {
    uuid: "compliance",
    taskUuid: "ad-complied/one-time",
    date: "2020-01-01",
    hours: null,
    cycles: null,
    method: "Inspected",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "Mechanic",
    certificate: "",
    evidence: "",
    recordedAt: 0,
    recordedBy: "demo-admin",
  };
  return { history: [entry] };
}

function pcw(): Partial<AD> {
  const r = blankAD("");
  return {
    applicability: "Previously Complied With (PCW)",
    source: {
      ...r.source,
      number: "AD-PCW",
      subject: "Subject",
      recurring: "No",
    },
  };
}
