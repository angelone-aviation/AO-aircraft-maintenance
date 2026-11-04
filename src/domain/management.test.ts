/**
 * Responsibility: Pins inventory and inspection commands: schedules and
 *   completions, component usage, stock balances, permissions, field limits,
 *   every refusal in order, and the change they store and audit.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/management.ts, ./model, ./rejection,
 *   src/data/demo.ts, tests/fixtures/componentMovement.ts.
 */
import { applyThroughWorkOrder } from "../../tests/fixtures/componentMovement";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  INSPECTION_REFERENCE_MAX_LENGTH,
  PURCHASE_REFERENCE_MAX_LENGTH,
  STOCK_VENDOR_MAX_LENGTH,
  applyManagement,
  componentTotals,
  inspectionCounters,
  inspectionSchema,
  mayMaintain,
  stockSchema,
  tracksLandings,
  validateMaintenanceTotals,
  type Component,
  type ManagedRecord,
  type ManagementCommand,
  type Stock,
} from "./management";
import {
  totalSeconds,
  type Aircraft,
  type Inspection,
  type Snapshot,
} from "./model";
import { Rejection } from "./rejection";

const common = () => ({
  requestUuid: crypto.randomUUID(),
  reason: "Maintenance record verified",
});
const component = (aircraftUuid: string): Component => ({
  kind: "component",
  componentType: "Engine",
  manufacturer: "",
  notes: "",
  trackTime: true,
  trackCycles: true,
  trackCalendar: true,
  timeSinceRepair: null,
  serviceDaysBase: 0,
  uuid: "component-1",
  version: 0,
  aircraftUuid,
  partNumber: "P1",
  serial: "S1",
  installed: false,
  partsLocation: "Shelf A",
  installedSeconds: 0,
  installedCycles: 0,
  timeSinceNew: 360000,
  timeSinceOverhaul: 180000,
  cyclesSinceNew: 100,
});
function setupStock() {
  const s = demoSnapshot();
  applyThroughWorkOrder(s, {
    ...common(),
    action: "record.save",
    record: {
      kind: "location",
      uuid: "store",
      version: 0,
      name: "Main store",
      address: "",
      contact: "",
    },
  });
  applyThroughWorkOrder(s, {
    ...common(),
    action: "record.save",
    record: {
      kind: "stock",
      uuid: "stock",
      version: 0,
      partNumber: "Oil",
      description: "Oil",
      alternates: "",
      category: "supply",
      condition: "new",
      locationUuid: "store",
      quantity: 0,
      minimum: 2,
    },
  });
  return s;
}
describe("maintenance and inventory domain", () => {
  it.each(["100H", "", "  "])(
    "recalculates recurring inspections and archives completions with reference %j",
    (reference) => {
      const s = demoSnapshot(),
        a = s.aircraft[0];
      applyThroughWorkOrder(s, {
        ...common(),
        action: "inspection.save",
        record: {
          uuid: "check",
          version: 0,
          aircraftUuid: a.uuid,
          reference,
          description: "Inspect",
          materials: "Oil",
          archived: false,
          intervalSeconds: 360000,
          intervalCycles: 100,
          intervalMonths: 12,
          lastSeconds: 0,
          lastCycles: 0,
          lastDate: "2024-02-12",
        },
      });
      expect(s.inspections.find((i) => i.uuid === "check")?.dueDate).toBe(
        "2025-02-28",
      );
      applyThroughWorkOrder(s, {
        ...common(),
        action: "inspection.complete",
        uuid: "check",
        version: 1,
        date: "2026-01-10",
        seconds: totalSeconds(a),
        cycles: a.cycles,
      });
      expect(s.inspections.find((i) => i.uuid === "check")).toMatchObject({
        dueSeconds: totalSeconds(a) + 360000,
        dueCycles: a.cycles + 100,
        dueDate: "2027-01-31",
        version: 2,
      });
      const once = s.inspections[0];
      applyThroughWorkOrder(s, {
        ...common(),
        action: "inspection.complete",
        uuid: once.uuid,
        version: 0,
        date: "2026-01-10",
        seconds: totalSeconds(a),
        cycles: a.cycles,
      });
      expect(s.inspections.find((i) => i.uuid === once.uuid)?.archived).toBe(
        true,
      );
    },
  );
  it("preserves component usage through installation, removal, and overhaul", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    applyThroughWorkOrder(s, {
      ...common(),
      action: "record.save",
      record: component(a.uuid),
    });
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 1,
      operation: "install",
      installPosition: "MAIN",
      date: new Date().toISOString().slice(0, 10),
    });
    a.currentHobbs += 7200;
    a.cycles += 3;
    const installed = s.management!.find(
      (r) => r.kind === "component",
    )! as Component;
    expect(componentTotals(installed, a)).toMatchObject({
      timeSinceNew: 367200,
      timeSinceOverhaul: 187200,
      cyclesSinceNew: 103,
    });
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 2,
      operation: "remove",
      partsLocation: "Shelf A",
      date: new Date().toISOString().slice(0, 10),
    });
    a.currentHobbs += 3600;
    expect(
      componentTotals(
        s.management!.find((r) => r.kind === "component")! as Component,
        a,
      ).timeSinceNew,
    ).toBe(367200);
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 3,
      operation: "overhaul",
      date: new Date().toISOString().slice(0, 10),
    });
    expect(s.management!.find((r) => r.kind === "component")!).toMatchObject({
      timeSinceNew: 367200,
      timeSinceOverhaul: 0,
      cyclesSinceNew: 103,
    });
  });
  it("uses component time for inspections and rejects flight corrections before installations", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    applyThroughWorkOrder(s, {
      ...common(),
      action: "record.save",
      record: component(a.uuid),
    });
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 1,
      operation: "install",
      installPosition: "MAIN",
      date: new Date().toISOString().slice(0, 10),
    });
    expect(
      inspectionCounters(
        {
          uuid: "i",
          aircraftUuid: a.uuid,
          reference: "Engine",
          description: "Check",
          componentUuid: "component-1",
        },
        a,
        s.management,
      ).seconds,
    ).toBe(360000);
    expect(() =>
      validateMaintenanceTotals(
        { ...a, currentHobbs: a.currentHobbs - 360 },
        s.management!,
        [],
      ),
    ).toThrow("installation");
  });
  it("measures a component inspection on the caller's date, not the clock's", () => {
    const a = demoSnapshot().aircraft[0];
    const installed: Component = {
      ...component(a.uuid),
      installed: true,
      installedDate: "2099-01-01",
      installedSeconds: totalSeconds(a),
      installedCycles: a.cycles,
    };
    const i: Inspection = {
      uuid: "i",
      aircraftUuid: a.uuid,
      reference: "Engine",
      description: "Check",
      componentUuid: installed.uuid,
    };
    expect(inspectionCounters(i, a, [installed], "2099-06-01")).toEqual({
      seconds: 360000,
      cycles: 100,
      landings: a.landings,
    });
    expect(() => inspectionCounters(i, a, [installed], "2098-12-01")).toThrow(
      "Aircraft readings or date precede the installation baseline.",
    );
  });
  it("rejects stale changes and insufficient stock without changing balances", () => {
    const s = setupStock();
    const receive: ManagementCommand = {
      ...common(),
      action: "stock.move",
      uuid: "stock",
      version: 1,
      operation: "receive",
      quantity: 5,
    };
    applyThroughWorkOrder(s, receive);
    expect(() => applyThroughWorkOrder(s, receive)).toThrow("changed");
    expect(() =>
      applyThroughWorkOrder(s, {
        ...common(),
        action: "stock.move",
        uuid: "stock",
        version: 2,
        operation: "issue",
        quantity: 6,
      }),
    ).toThrow("Insufficient");
    expect(
      (s.management!.find((r) => r.uuid === "stock") as Stock).quantity,
    ).toBe(5);
    applyThroughWorkOrder(s, {
      ...common(),
      action: "stock.move",
      uuid: "stock",
      version: 2,
      operation: "adjust",
      quantity: 0,
    });
    expect(
      (s.management!.find((r) => r.uuid === "stock") as Stock).quantity,
    ).toBe(0);
  });
  it("denies pilots maintenance writes and inventory access", () => {
    const s = demoSnapshot();
    s.user = s.members.find((m) => !m.isAdmin)!;
    expect(() =>
      applyThroughWorkOrder(s, {
        ...common(),
        action: "record.save",
        record: component(s.aircraft[0].uuid),
      }),
    ).toThrow("Permission");
    expect(() =>
      applyThroughWorkOrder(s, {
        ...common(),
        action: "record.save",
        record: {
          kind: "location",
          uuid: "x",
          version: 0,
          name: "Store",
          address: "",
          contact: "",
        },
      }),
    ).toThrow("Permission");
  });
});

it("allows explicit initial setup for a new installed component but cannot bypass movement rules", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const record: Component = {
    ...component(a.uuid),
    installed: true,
    partsLocation: undefined,
    installedDate: "2025-01-01",
    installPosition: "MAIN",
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
  };
  expect(() =>
    applyManagement(s, { ...common(), action: "record.save", record }),
  ).toThrow("work order");
  applyManagement(s, {
    ...common(),
    action: "record.save",
    record,
    initialAircraftSetup: true,
  });
  const saved = s.management!.find((r) => r.uuid === record.uuid)!;
  expect(saved.kind === "component" && saved.installed).toBe(true);
  expect(saved.kind === "component" && saved.aircraftUuid).toBe(a.uuid);
  expect(() =>
    applyManagement(s, {
      ...common(),
      action: "record.save",
      record: saved,
      initialAircraftSetup: true,
    }),
  ).toThrow("only for a new");
  if (saved.kind !== "component") throw Error("Missing component");
  expect(() =>
    applyManagement(s, {
      ...common(),
      action: "record.save",
      record: { ...saved, installed: false, partsLocation: "Shelf A" },
    }),
  ).toThrow();
});

const NOW = Date.parse("2026-10-30T12:00:00Z");
const PROGRAM = "demo-program";
const HOUR_SECONDS = 3600;

/**
 * The demo program with two stores, an oil lot, a reserved lot, a vendor, a
 * spare with an overhaul limit, an installed engine with a life limit, a
 * component out for repair, and inspections: a 100-hour phase, a landing
 * check, an archived one and an engine check; plus a lot in another program.
 */
function world() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.programs = [...s.programs!, { ...s.programs![0], uuid: "other" }];
  const owned = { version: 1, programUuid: PROGRAM };
  const store = (uuid: string) => ({
    ...owned,
    kind: "location" as const,
    uuid,
    name: uuid,
    address: "",
    contact: "",
  });
  const lot = (uuid: string, extra: Partial<Stock> = {}): Stock => ({
    ...owned,
    kind: "stock",
    uuid,
    partNumber: "OIL",
    alternates: "",
    description: "Oil",
    category: "supply",
    condition: "new",
    locationUuid: "store",
    quantity: 5,
    minimum: 1,
    reservedQuantity: 0,
    ...extra,
  });
  const engine: Component = {
    ...component(a.uuid),
    ...owned,
    uuid: "engine",
    serial: "S-engine",
    installed: true,
    partsLocation: undefined,
    installPosition: "MAIN",
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
  };
  s.management = [
    store("store"),
    store("store2"),
    lot("oil"),
    lot("held", { reservedQuantity: 2 }),
    lot("foreign", { programUuid: "other" }),
    { ...owned, kind: "vendor", uuid: "acme", name: "Acme", website: "" },
    { ...component(a.uuid), ...owned, uuid: "spare", serial: "S-spare" },
    engine,
    {
      ...component(a.uuid),
      ...owned,
      uuid: "away",
      serial: "S-away",
      outForRepair: { poUuid: "po", date: "2026-10-01" },
    },
    {
      ...owned,
      kind: "componentRequirement",
      uuid: "life",
      componentUuid: "engine",
      aircraftUuid: a.uuid,
      requirementType: "Life Limits",
      description: "Life",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
      dueDate: "2030-01-01",
    },
    {
      ...owned,
      kind: "componentRequirement",
      uuid: "tbo",
      componentUuid: "spare",
      aircraftUuid: a.uuid,
      requirementType: "Life Limits",
      description: "Time between overhauls",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSO",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      intervalSeconds: 1000 * HOUR_SECONDS,
      dueSeconds: 1000 * HOUR_SECONDS,
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
    },
  ] as ManagedRecord[];
  const inspection = (uuid: string, extra: Partial<Inspection> = {}) => ({
    ...owned,
    uuid,
    aircraftUuid: a.uuid,
    reference: uuid,
    description: uuid,
    materials: "",
    archived: false,
    intervalSeconds: 100 * HOUR_SECONDS,
    lastSeconds: 0,
    ...extra,
  });
  s.inspections = [
    inspection("phase", { sourceKey: "manual:1" }),
    inspection("landing-check", {
      intervalSeconds: undefined,
      lastSeconds: undefined,
      intervalLandings: 500,
      lastLandings: 0,
    }),
    inspection("done", { archived: true }),
    inspection("engine-check", {
      componentUuid: "engine",
      lastSeconds: 360000,
    }),
  ];
  return { s, a };
}
type World = ReturnType<typeof world>;
const stored = (s: Snapshot, uuid: string) =>
  structuredClone(s.management!.find((r) => r.uuid === uuid)!);
const phase = (s: Snapshot) =>
  structuredClone(s.inspections.find((i) => i.uuid === "phase")!);
const newInspection = (a: Aircraft, extra: Partial<Inspection>) => ({
  uuid: "new-inspection",
  version: 0,
  aircraftUuid: a.uuid,
  reference: "",
  description: "New",
  materials: "",
  archived: false,
  ...extra,
});
const saveRecord = (record: object, extra: object = {}) => ({
  ...common(),
  action: "record.save",
  record,
  ...extra,
});

// Each refusal in the order applyManagement checks it, with its exact message.
const refusals: [string, (w: World) => object][] = [
  [
    "Record belongs to another Flight Program.",
    () => ({
      ...common(),
      action: "stock.move",
      uuid: "foreign",
      version: 1,
      operation: "receive",
      quantity: 1,
    }),
  ],
  [
    "Use an explicit Flight Program transfer.",
    () =>
      saveRecord({
        kind: "location",
        uuid: "new",
        version: 0,
        programUuid: "other",
        name: "X",
        address: "",
        contact: "",
      }),
  ],
  [
    "Storage location must belong to this Flight Program.",
    ({ s }) =>
      saveRecord({
        ...stored(s, "oil"),
        uuid: "new",
        version: 0,
        locationUuid: "nowhere",
      }),
  ],
  [
    "Component must belong to this Flight Program.",
    ({ s }) =>
      saveRecord({
        ...stored(s, "life"),
        uuid: "new",
        version: 0,
        componentUuid: "missing",
      }),
  ],
  [
    "Permission denied.",
    ({ s }) => {
      s.user = s.members.find((m) => !m.isAdmin)!;
      return saveRecord({ ...stored(s, "store"), uuid: "new", version: 0 });
    },
  ],
  [
    "Records cannot be moved between aircraft.",
    ({ s }) => ({
      ...common(),
      action: "inspection.save",
      record: { ...phase(s), aircraftUuid: s.aircraft[1].uuid },
    }),
  ],
  [
    "This manual item has already been added to the selected target.",
    ({ a }) => ({
      ...common(),
      action: "inspection.save",
      // Stale as well: the duplicate is refused before the version check.
      record: newInspection(a, {
        sourceKey: "manual:1",
        dueDate: "2027-01-01",
        version: 1,
      }),
    }),
  ],
  [
    "This record changed. Refresh and try again.",
    () => ({
      ...common(),
      action: "stock.move",
      uuid: "oil",
      version: 0,
      operation: "receive",
      quantity: 1,
    }),
  ],
  [
    "Enter a reason/reference for the calendar exemption.",
    ({ s }) => ({
      ...common(),
      action: "inspection.save",
      record: { ...phase(s), calendarExempt: true },
    }),
  ],
  [
    "Create a new schedule with verified baselines to change its time source.",
    ({ s }) => ({
      ...common(),
      action: "inspection.save",
      record: { ...phase(s), usageMeter: "collective" },
    }),
  ],
  [
    "Create a new schedule to change the tracked component.",
    ({ s }) => ({
      ...common(),
      action: "inspection.save",
      record: { ...phase(s), componentUuid: "engine" },
    }),
  ],
  [
    "Inspection component not found.",
    ({ a }) => ({
      ...common(),
      action: "inspection.save",
      record: newInspection(a, {
        componentUuid: "missing",
        dueDate: "2027-01-01",
      }),
    }),
  ],
  [
    "Enter at least one due limit or recurring interval.",
    ({ a }) => ({
      ...common(),
      action: "inspection.save",
      record: newInspection(a, {}),
    }),
  ],
  [
    "Service dates cannot be in the future.",
    ({ a }) => ({
      ...common(),
      action: "inspection.save",
      record: newInspection(a, {
        dueDate: "2027-01-01",
        lastDate: "2030-01-01",
      }),
    }),
  ],
  [
    "Last compliance cannot exceed aircraft totals.",
    ({ a }) => ({
      ...common(),
      action: "inspection.save",
      record: newInspection(a, {
        dueSeconds: 1,
        lastSeconds: totalSeconds(a) + 1,
      }),
    }),
  ],
  [
    "Each interval requires its last compliance reading or date.",
    ({ a }) => ({
      ...common(),
      action: "inspection.save",
      record: newInspection(a, { intervalSeconds: 1 }),
    }),
  ],
  [
    "Inspection not found.",
    () => ({
      ...common(),
      action: "inspection.complete",
      uuid: "nope",
      version: 0,
      date: "2026-10-01",
      seconds: 0,
      cycles: 0,
    }),
  ],
  [
    "Inspection is archived.",
    () => ({
      ...common(),
      action: "inspection.complete",
      uuid: "done",
      version: 1,
      date: "2026-10-01",
      seconds: 0,
      cycles: 0,
    }),
  ],
  [
    "Enter aircraft total landings at completion.",
    ({ a }) => ({
      ...common(),
      action: "inspection.complete",
      uuid: "landing-check",
      version: 1,
      date: "2026-10-01",
      seconds: 0,
      cycles: a.cycles,
    }),
  ],
  [
    "Compliance readings must be between last compliance and current aircraft totals.",
    ({ a }) => ({
      ...common(),
      action: "inspection.complete",
      uuid: "phase",
      version: 1,
      date: "2026-10-01",
      seconds: totalSeconds(a) + 1,
      cycles: 0,
    }),
  ],
  [
    "A vendor with this name already exists.",
    () =>
      saveRecord({
        kind: "vendor",
        uuid: "new",
        version: 0,
        name: "ACME",
        website: "",
      }),
  ],
  [
    "Record type cannot change.",
    ({ s }) => saveRecord({ ...stored(s, "store"), uuid: "oil" }),
  ],
  [
    "Initial aircraft setup is only for a new, already-installed component.",
    ({ s }) => saveRecord(stored(s, "spare"), { initialAircraftSetup: true }),
  ],
  [
    "Receive the component from repair before editing it.",
    ({ s }) => saveRecord(stored(s, "away")),
  ],
  [
    "Ship components for repair through their purchase order.",
    ({ s }) => saveRecord({ ...stored(s, "away"), uuid: "new", version: 0 }),
  ],
  [
    "Add the component to inventory, then install it through a work order.",
    ({ s }) => saveRecord({ ...stored(s, "engine"), uuid: "new", version: 0 }),
  ],
  [
    "Movement history is immutable. Use component actions.",
    ({ a }) =>
      saveRecord({
        kind: "componentMovement",
        uuid: "new",
        version: 0,
        componentUuid: "spare",
        aircraftUuid: a.uuid,
        action: "REPAIR",
        date: "2026-10-01",
        timeSinceNew: 0,
        timeSinceOverhaul: null,
        timeSinceRepair: null,
        cycles: 0,
        serviceDays: 0,
        note: "x",
        actorId: "x",
        at: 0,
      }),
  ],
  [
    "The linked component cannot change.",
    ({ s }) => saveRecord({ ...stored(s, "life"), componentUuid: "spare" }),
  ],
  [
    "Change reservations through Parts requests.",
    ({ s }) => saveRecord({ ...stored(s, "oil"), reservedQuantity: 3 }),
  ],
  [
    "Release stock reservations before changing part identity, condition or reducing stock below its reserved quantity.",
    ({ s }) => saveRecord({ ...stored(s, "held"), quantity: 1 }),
  ],
  [
    "Location is fixed for each stock lot.",
    ({ s }) => saveRecord({ ...stored(s, "oil"), locationUuid: "store2" }),
  ],
  [
    "Component not found.",
    () => ({
      ...common(),
      action: "component.service",
      uuid: "nope",
      version: 0,
      operation: "overhaul",
      date: "2026-10-01",
    }),
  ],
  [
    "Receive the component from repair before changing it.",
    () => ({
      ...common(),
      action: "component.service",
      uuid: "away",
      version: 1,
      operation: "overhaul",
      date: "2026-10-01",
    }),
  ],
  [
    "Provide a baseline source or reason of at least 10 characters.",
    ({ s }) => ({
      ...stored(s, "spare"),
      ...common(),
      reason: "Too short",
      action: "component.baseline",
      uuid: "spare",
      version: 1,
      installedDate: "2026-01-01",
    }),
  ],
  [
    "Installations and removals must be completed through a work order.",
    () => ({
      ...common(),
      action: "component.service",
      uuid: "spare",
      version: 1,
      operation: "install",
      date: "2026-10-01",
    }),
  ],
  [
    "Baseline would precede recorded inspection compliance.",
    ({ s }) => ({
      ...stored(s, "engine"),
      ...common(),
      action: "component.baseline",
      uuid: "engine",
      version: 1,
      timeSinceNew: 0,
      timeSinceOverhaul: 0,
      installedDate: "2026-01-01",
    }),
  ],
  [
    "Stock item not found.",
    () => ({
      ...common(),
      action: "stock.move",
      uuid: "nope",
      version: 0,
      operation: "receive",
      quantity: 1,
    }),
  ],
  [
    "Movement quantity must be positive.",
    () => ({
      ...common(),
      action: "stock.move",
      uuid: "oil",
      version: 1,
      operation: "receive",
      quantity: 0,
    }),
  ],
  [
    "Insufficient stock or invalid quantity.",
    () => ({
      ...common(),
      action: "stock.move",
      uuid: "oil",
      version: 1,
      operation: "issue",
      quantity: 6,
    }),
  ],
];

describe("management refusals", () => {
  it.each(refusals)("refuses: %s", (message, build) => {
    const w = world();
    const command = build(w) as ManagementCommand;
    const before = structuredClone({
      management: w.s.management,
      inspections: w.s.inspections,
      audit: w.s.audit,
    });
    expect(() => applyManagement(w.s, command, NOW)).toThrow(message);
    let error: unknown;
    try {
      applyManagement(w.s, command, NOW);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Rejection);
    expect((error as Error).message).toBe(message);
    expect({
      management: w.s.management,
      inspections: w.s.inspections,
      audit: w.s.audit,
    }).toEqual(before);
  });
});

describe("maintenance totals", () => {
  it("refuses totals before an installation, service compliance or inspection compliance", () => {
    const { s, a } = world();
    const records = s.management!;
    const earlier = { ...a, currentHobbs: a.currentHobbs - HOUR_SECONDS };
    expect(() => validateMaintenanceTotals(earlier, records, [])).toThrow(
      "Correction would move aircraft totals before a component installation.",
    );
    const service = {
      ...stored(s, "life"),
      intervalLandings: 100,
      lastLandings: a.landings + 1,
    } as ManagedRecord;
    expect(() => validateMaintenanceTotals(a, [service], [])).toThrow(
      "Correction would move landings before recorded service compliance.",
    );
    const inspection = { ...phase(s), lastSeconds: totalSeconds(a) + 1 };
    expect(() => validateMaintenanceTotals(a, [], [inspection])).toThrow(
      "Correction would move usage before recorded inspection compliance.",
    );
    expect(() =>
      validateMaintenanceTotals(a, records, s.inspections),
    ).not.toThrow();
  });

  it("names the installation first, and skips other aircraft's inspections", () => {
    const { s, a } = world();
    const service = {
      ...stored(s, "life"),
      intervalLandings: 100,
      lastLandings: a.landings + 1,
    } as ManagedRecord;
    const earlier = { ...a, currentHobbs: a.currentHobbs - HOUR_SECONDS };
    const both = () =>
      validateMaintenanceTotals(earlier, [...s.management!, service], []);
    expect(both).toThrow(Rejection);
    expect(both).toThrow("before a component installation.");
    const elsewhere = {
      ...phase(s),
      aircraftUuid: s.aircraft[1].uuid,
      lastSeconds: totalSeconds(a) + 1,
    };
    expect(() => validateMaintenanceTotals(a, [], [elsewhere])).not.toThrow();
  });
});

describe("schedule and inventory rules", () => {
  it("tracks landings with a landings interval or a one-time landings limit", () => {
    expect(tracksLandings({})).toBe(false);
    expect(tracksLandings({ intervalLandings: 100 })).toBe(true);
    expect(tracksLandings({ dueLandings: 0 })).toBe(true);
  });

  it("lets maintenance change an aircraft's records there, and others in the program", () => {
    const s = demoSnapshot();
    const [a, b] = s.aircraft;
    expect([mayMaintain(s, a.uuid), mayMaintain(s, undefined)]).toEqual([
      true,
      true,
    ]);
    s.user = { ...s.user, isAdmin: false, groupIds: ["mechanics"] };
    s.groups = [
      {
        id: "mechanics",
        name: "Mechanics",
        programUuid: s.activeProgramUuid,
        aircraftIds: [a.uuid],
        permissions: ["read", "maintenance"],
      },
    ];
    expect(
      [a.uuid, b.uuid, undefined].map((uuid) => mayMaintain(s, uuid)),
    ).toEqual([true, false, true]);
    s.groups[0].permissions = ["read", "flight"];
    expect([mayMaintain(s, a.uuid), mayMaintain(s, undefined)]).toEqual([
      false,
      false,
    ]);
  });

  it("limits a lot's vendor and purchase references and a schedule's reference", () => {
    expect([
      STOCK_VENDOR_MAX_LENGTH,
      PURCHASE_REFERENCE_MAX_LENGTH,
      INSPECTION_REFERENCE_MAX_LENGTH,
    ]).toEqual([200, 100, 2000]);
    const { s } = world();
    const lot = stored(s, "oil");
    const inspection = s.inspections[0];
    const lotFits = (key: string, n: number) =>
      stockSchema.safeParse({ ...lot, [key]: "x".repeat(n) }).success;
    expect(lotFits("vendor", STOCK_VENDOR_MAX_LENGTH)).toBe(true);
    expect(lotFits("vendor", STOCK_VENDOR_MAX_LENGTH + 1)).toBe(false);
    for (const key of ["invoiceNumber", "poRef"]) {
      expect(lotFits(key, PURCHASE_REFERENCE_MAX_LENGTH)).toBe(true);
      expect(lotFits(key, PURCHASE_REFERENCE_MAX_LENGTH + 1)).toBe(false);
    }
    const reference = (n: number) =>
      inspectionSchema.safeParse({ ...inspection, reference: "x".repeat(n) })
        .success;
    expect(reference(INSPECTION_REFERENCE_MAX_LENGTH)).toBe(true);
    expect(reference(INSPECTION_REFERENCE_MAX_LENGTH + 1)).toBe(false);
  });
});

describe("management results", () => {
  it("returns a stock movement and audits it with the record before and after", () => {
    const { s } = world();
    const before = stored(s, "oil");
    const command: ManagementCommand = {
      ...common(),
      action: "stock.move",
      uuid: "oil",
      version: 1,
      operation: "receive",
      quantity: 2,
    };
    const result = applyManagement(s, command, NOW);
    const next = { ...before, quantity: 7, version: 2 };
    expect(result).toStrictEqual({
      next,
      before,
      aircraftUuid: undefined,
      records: [next],
      updatedInspections: [],
    });
    expect(s.management!.at(-1)).toStrictEqual(next);
    expect(s.audit[0]).toStrictEqual({
      uuid: command.requestUuid,
      programUuid: "demo-program",
      actorId: s.user.id,
      at: NOW,
      action: "stock.move.receive",
      entityUuid: "oil",
      aircraftUuid: undefined,
      reason: command.reason,
      before: JSON.stringify(before),
      after: JSON.stringify(next),
    });
  });

  it("renews a completed inspection on its aircraft", () => {
    const { s, a } = world();
    const result = applyManagement(
      s,
      {
        ...common(),
        action: "inspection.complete",
        uuid: "phase",
        version: 1,
        date: "2026-10-01",
        seconds: totalSeconds(a),
        cycles: a.cycles,
      },
      NOW,
    );
    expect(result).toMatchObject({
      next: {
        lastDate: "2026-10-01",
        lastSeconds: totalSeconds(a),
        dueSeconds: totalSeconds(a) + 100 * HOUR_SECONDS,
        archived: false,
        version: 2,
      },
      aircraftUuid: a.uuid,
      records: [],
    });
    expect(s.inspections.at(-1)).toBe(result.next);
    expect(s.audit[0].action).toBe("inspection.complete");
  });

  it("saves a requirement one version on, and keeps a component's creation time", () => {
    const { s } = world();
    const tbo = applyManagement(
      s,
      saveRecord(stored(s, "tbo")) as ManagementCommand,
      NOW,
    );
    expect(tbo.next.version).toBe(2);
    const spare = {
      ...stored(s, "spare"),
      uuid: "new",
      version: 0,
      serial: "S-new",
    };
    applyManagement(s, saveRecord(spare) as ManagementCommand, NOW);
    const edited = applyManagement(
      s,
      saveRecord({ ...stored(s, "new"), notes: "Edited" }) as ManagementCommand,
      NOW + 1,
    );
    expect(edited.next).toMatchObject({
      notes: "Edited",
      createdAt: NOW,
      version: 2,
    });
  });

  it("stores an overhaul with its rebased limit and movement after the component", () => {
    const { s } = world();
    const result = applyManagement(
      s,
      {
        ...common(),
        action: "component.service",
        uuid: "spare",
        version: 1,
        operation: "overhaul",
        date: "2026-10-30",
      },
      NOW,
    );
    expect(result.records.map((r) => [r.kind, r.uuid])).toEqual([
      ["component", "spare"],
      ["componentRequirement", "tbo"],
      ["componentMovement", expect.any(String)],
    ]);
    expect(s.management!.slice(-3)).toEqual(result.records);
    expect(result.records[2]).toMatchObject({ action: "OVERHAUL" });
    expect(s.audit[0].action).toBe("component.service.overhaul");
  });

  it("moves a component's inspections to the component's aircraft", () => {
    const { s, a } = world();
    const check = s.inspections.find((i) => i.uuid === "engine-check")!;
    check.aircraftUuid = s.aircraft[1].uuid;
    const result = applyManagement(
      s,
      {
        ...(stored(s, "engine") as Component),
        ...common(),
        action: "component.baseline",
        uuid: "engine",
        version: 1,
        installedDate: "2026-01-01",
      } as ManagementCommand,
      NOW,
    );
    const moved = { ...check, aircraftUuid: a.uuid, version: 2 };
    expect(result.updatedInspections).toEqual([moved]);
    expect(s.inspections.find((i) => i.uuid === "engine-check")).toEqual(moved);
  });
});
