/**
 * Responsibility: Seeds a convex-test database with one Flight Program at the
 *   size test's volume for one or more fleet-years, as the app stores it, and
 *   one account per kind of view.
 * Layer: Test. Fixture for convex-test suites; never shipped in the build.
 * Dependencies: convex/_generated (types), convex/collections.ts (codec),
 *   convex/recordNumbers.ts, convex/costLedger.ts, src/data/demo.ts,
 *   src/domain stored-record schemas and builders.
 *
 * Volumes follow the size test's profile (per aircraft per year: 300
 * flights, 12 work orders of 15 job cards, 30 problem reports, 60 flight
 * plans, 30 parts requests, 20 purchase orders; 100 components, 30
 * inspections and 40 ADs per aircraft; 300 stock records), with shorter
 * text. Everything is derived from counters, so two runs store the same rows.
 * Earlier years repeat the newest year's records a year apart, all closed,
 * after it in each table, so the one-year database is unchanged.
 */
import type { MutationCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { decode, encode, type StoredRow } from "../../convex/collections";
import { recordNumberOf } from "../../convex/recordNumbers";
import { derivedLedger } from "../../convex/costLedger";
import { demoSnapshot } from "../../src/data/demo";
import { adSchema } from "../../src/domain/airworthiness";
import { costRecordSchema } from "../../src/domain/costs";
import { inspectionSchema, recordSchema } from "../../src/domain/management";
import { flightPlanSchema } from "../../src/domain/flightPlans";
import { partsRequestSchema } from "../../src/domain/partsRequests";
import { poSchema } from "../../src/domain/purchaseOrders";
import { taskCardDefaults, taskCardSchema } from "../../src/domain/taskCards";
import { workOrderSchema } from "../../src/domain/workOrders";

export const VOLUME_PROGRAM = "demo-program";
/** The size test's one-year volume. */
export const VOLUME = {
  aircraft: 6,
  flights: 300,
  workOrders: 12,
  jobCardsPerWorkOrder: 15,
  flightPlanEvery: 5,
  reportEvery: 10,
  partsRequests: 30,
  purchaseOrders: 20,
  components: 100,
  inspections: 30,
  ads: 40,
  stock: 300,
  locations: 6,
  evidenceEvery: 10,
  inventoryFileEvery: 30,
} as const;

const DAY = 86_400_000;
const YEAR = 365 * DAY;
const HOUR = 3600;
// The parts requests' fixed fields; zod writes them in schema order.
const REQUEST_TEXT = {
  mode: "parts",
  date: "2026-10-24",
  engineer: "Mechanic",
  base: "Test Field",
  priority: "P2 Routine",
  requiredBy: "2026-11-01",
  timeframe: "",
  vendor: "Example Aviation Supply",
  vendorAddress: "1 Supply Road",
  currency: "USD",
  shipTo: "Hangar 4",
  billTo: "Hangar 4",
  shipFrom: "",
  aircraftYear: "2006",
  notes: "",
  shippingInstructions: "Ground",
  returnInstructions: "",
  programUuid: VOLUME_PROGRAM,
  cancelled: false,
};
const STEPS = [
  "Remove cowlings and inspect for cracks, chafing and missing fasteners.",
  "Inspect lines and hoses for leaks, chafing and security.",
  "Measure brake lining thickness and record the reading.",
  "Inspect mounts and attaching hardware for cracks and corrosion.",
  "Reinstall panels and verify fastener security.",
];

/** The accounts a volume database signs in as, by view. */
export interface VolumeAccounts {
  /** System administrator: the full workspace with every record. */
  admin: string;
  /** Pilot on the first two aircraft: read, flight and discrepancy. */
  pilot: string;
  /** Aircraft owner of the first aircraft. */
  owner: string;
  /** Board member over every aircraft. */
  board: string;
}

/** What the database holds, for assertions that scale with it. */
export interface VolumeCounts {
  aircraft: string[];
  jobCards: number;
  workOrders: number;
}

type Row = Record<string, unknown>;

/**
 * Seeds the program, its aircraft and `years` years of records, files on some
 * job cards, work orders and stock, and the four accounts. Only the newest
 * year holds an open work order and open problem reports; earlier years hold
 * the same records a whole year apart, closed.
 *
 * @param at - The newest record's time; records reach back `years` years.
 * @param years - Fleet-years of records, a whole number from 1.
 * @returns The accounts' convex-test identity subjects and the counts.
 * @throws {RangeError} When `years` is not a whole number of at least 1.
 */
export async function seedProgramVolume(
  ctx: MutationCtx,
  at: number,
  years = 1,
) {
  if (!Number.isInteger(years) || years < 1)
    throw new RangeError(
      `Volume years must be a whole number from 1: ${years}`,
    );
  const gen = new Generator(at);
  const ids = await seedPeople(ctx);
  gen.users = ids.users;
  await ctx.db.insert("programs", demoSnapshot().programs![0]);
  const blob = await ctx.storage.store(new Blob(["%PDF-1.4 evidence"]));
  const tables = gen.program(blob);
  for (let back = 1; back < years; back++) gen.pastYear(tables, back, blob);
  tables.recordNumbers = numberRows(tables);
  tables.costLedger = ledgerRows(tables);
  for (const [table, rows] of Object.entries(tables))
    for (const row of rows) await ctx.db.insert(table as "audit", row as never);
  return {
    accounts: ids.accounts,
    counts: {
      aircraft: gen.aircraftUuids,
      jobCards: tables.taskCards.length + tables.archivedTaskCards.length,
      workOrders: tables.workOrders.length,
    } satisfies VolumeCounts,
  };
}

/**
 * Adds older history to the first aircraft: a work order completed two years
 * before `at` with completed job cards, a photo on every tenth, which the
 * workspace's window leaves out, to show that what the snapshot reads does
 * not grow with it.
 *
 * @param count - Job cards to add to the order.
 */
export async function addOlderHistory(
  ctx: MutationCtx,
  at: number,
  count: number,
) {
  const gen = new Generator(at - 2 * YEAR, "e");
  gen.users = {
    admin: "admin",
    pilot: "pilot",
    owner: "owner",
    board: "board",
  };
  const aircraft = demoAircraft(0);
  const blob = await ctx.storage.store(new Blob(["%PDF-1.4 evidence"]));
  const order = gen.workOrder(aircraft, 0, true);
  await ctx.db.insert("workOrders", encode("workOrders", order));
  for (let n = 0; n < count; n++) {
    const card = gen.taskCard(aircraft.uuid, order.uuid, n, true);
    await ctx.db.insert("taskCards", encode("taskCards", card));
    if (n % VOLUME.evidenceEvery === 0)
      await ctx.db.insert("taskEvidence", {
        taskCardUuid: card.uuid,
        aircraftUuid: aircraft.uuid,
        workOrderUuid: order.uuid,
        storageId: blob,
        name: `card-${card.uuid.slice(-6)}.pdf`,
        size: 2048,
        uploadedAt: at - 2 * YEAR,
        category: "photo",
      });
  }
}

// The cost ledger rows the app writes beside each work order's cost record.
// No request of the fixture counts toward a work order, so each record is
// all its order's ledger reads.
function ledgerRows(tables: Record<string, Row[]>) {
  const orders = new Map(
    decode("workOrders", tables.workOrders as StoredRow<"workOrders">[]).map(
      (w) => [w.uuid, w],
    ),
  );
  return decode("costs", tables.costs as StoredRow<"costs">[]).flatMap(
    (record) => {
      if (record.kind !== "workOrder") return [];
      const records = {
        costs: [record],
        taskCards: [],
        archivedTaskCards: [],
        partsRequests: [],
      };
      return derivedLedger(orders.get(record.workOrderUuid)!, records) as Row[];
    },
  );
}

// The number rows the app writes beside each work order and job card.
function numberRows(tables: Record<string, Row[]>) {
  const rows = (collection: "workOrders" | "taskCards") =>
    tables[collection].map((row) =>
      recordNumberOf(collection, row as StoredRow<typeof collection>),
    );
  return [...rows("workOrders"), ...rows("taskCards")] as Row[];
}

async function seedPeople(ctx: MutationCtx) {
  const [first, second] = [demoAircraft(0).uuid, demoAircraft(1).uuid];
  const group = (name: string, extra: Row) =>
    ctx.db.insert("groups", {
      programUuid: VOLUME_PROGRAM,
      name,
      aircraftIds: [],
      permissions: ["read"],
      ...extra,
    });
  const pilots = await group("Pilots", {
    aircraftIds: [first, second],
    permissions: ["read", "flight", "discrepancy"],
  });
  const owners = await group("Owners", { owner: true, aircraftIds: [first] });
  const board = await group("Board", { board: true });
  const users = {
    admin: await account(ctx, "Administrator", true, []),
    pilot: await account(ctx, "Pilot", false, [pilots]),
    owner: await account(ctx, "Owner", false, [owners]),
    board: await account(ctx, "Board member", false, [board]),
  };
  return {
    users: Object.fromEntries(
      Object.entries(users).map(([k, v]) => [k, v.id]),
    ) as Record<keyof VolumeAccounts, string>,
    accounts: Object.fromEntries(
      Object.entries(users).map(([k, v]) => [k, v.subject]),
    ) as unknown as VolumeAccounts,
  };
}

async function account(
  ctx: MutationCtx,
  name: string,
  isAdmin: boolean,
  groupIds: Id<"groups">[],
) {
  const id = await ctx.db.insert("users", {
    name,
    email: `${name.replace(/\W/g, "").toLowerCase()}@example.test`,
    active: true,
    isAdmin,
    activeProgramUuid: VOLUME_PROGRAM,
    groupIds,
  });
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime: Date.now() + DAY,
  });
  return { id: id as string, subject: `${id}|${session}` };
}

function demoAircraft(n: number) {
  const base = demoSnapshot().aircraft[0];
  return {
    ...base,
    uuid: `volume-aircraft-${n + 1}`,
    registration: `N${n + 1}00VT`,
    serial: `VOL-${n + 1}`,
  };
}

type Aircraft = ReturnType<typeof demoAircraft>;

// Builds the rows; `uuid()` draws from one counter so runs match. An earlier
// year has its own generator, uuid prefix and number suffix, so its uuids and
// record numbers never repeat the newest year's.
class Generator {
  users: Record<keyof VolumeAccounts, string> = {
    admin: "",
    pilot: "",
    owner: "",
    board: "",
  };
  aircraftUuids: string[] = [];
  private next = 0;
  private stock: { uuid: string; locationUuid: string; partNumber: string }[] =
    [];
  private readonly suffix: string;

  constructor(
    private readonly end: number,
    private readonly prefix = "0",
    private readonly yearsBack = 0,
  ) {
    this.suffix = yearsBack ? `-${yearsBack}y` : "";
  }

  uuid() {
    const hex = (this.next++).toString(16).padStart(8, "0");
    return `${this.prefix.padStart(8, "0")}-0000-4000-8000-0000${hex}`;
  }

  program(blob: Id<"_storage">) {
    const t: Record<string, Row[]> = {
      aircraft: [],
      management: [],
      costs: [],
      flights: [],
      discrepancies: [],
      flightPlans: [],
      inspections: [],
      airworthiness: [],
      workOrders: [],
      taskCards: [],
      archivedTaskCards: [],
      partsRequests: [],
      purchaseOrders: [],
      audit: [],
      taskEvidence: [],
      workOrderFiles: [],
      inventoryFiles: [],
    };
    this.programRecords(t, blob);
    for (let n = 0; n < VOLUME.aircraft; n++) this.aircraftYear(t, n, blob);
    return t as Record<string, Row[]> & {
      taskCards: Row[];
      archivedTaskCards: Row[];
      workOrders: Row[];
    };
  }

  // Adds the year `yearsBack` years before this generator's: the flights,
  // maintenance and purchasing, not the fleet's components, inspections, ADs
  // or stock, which a fleet holds once.
  pastYear(t: Record<string, Row[]>, yearsBack: number, blob: Id<"_storage">) {
    const past = new Generator(
      this.end - yearsBack * YEAR,
      String(yearsBack),
      yearsBack,
    );
    past.users = this.users;
    past.stock = this.stock;
    for (let n = 0; n < VOLUME.aircraft; n++) {
      const aircraft = demoAircraft(n);
      past.flightsOf(t, aircraft);
      past.maintenanceOf(t, aircraft, blob);
      past.purchasingOf(t, aircraft);
    }
  }

  private programRecords(t: Record<string, Row[]>, blob: Id<"_storage">) {
    const locations = Array.from({ length: VOLUME.locations }, (_, i) =>
      this.managed(t, {
        uuid: this.uuid(),
        version: 1,
        programUuid: VOLUME_PROGRAM,
        kind: "location",
        name: `Stores bay ${i + 1}`,
        address: `Hangar 4, bay ${i + 1}`,
        contact: "stores@example.test",
      }),
    );
    this.stockAt(t, locations, blob);
    t.costs.push(
      encode(
        "costs",
        costRecordSchema.parse({
          version: 1,
          uuid: this.uuid(),
          programUuid: VOLUME_PROGRAM,
          kind: "settings",
          laborRateCents: 9500,
        }),
      ),
    );
  }

  private stockAt(
    t: Record<string, Row[]>,
    locations: { uuid: string }[],
    blob: Id<"_storage">,
  ) {
    for (let i = 0; i < VOLUME.stock; i++) {
      const stock = {
        uuid: this.uuid(),
        locationUuid: locations[i % locations.length].uuid,
        partNumber: `LT-${4000 + i}`,
      };
      this.stock.push(stock);
      this.managed(t, {
        ...stock,
        version: 1,
        programUuid: VOLUME_PROGRAM,
        kind: "stock",
        alternates: "",
        description: "Oil filter",
        category: "part",
        condition: "new",
        quantity: 2 + (i % 11),
        minimum: 2,
        vendor: "Example Aviation Supply",
        cost: 12.5 + (i % 40) * 3,
      });
      if (i % VOLUME.inventoryFileEvery === 0)
        t.inventoryFiles.push({
          stockUuid: stock.uuid,
          storageId: blob,
          name: `Certificate ${i}.pdf`,
          type: "application/pdf",
          size: 1024,
          uploadedAt: this.end - DAY,
        });
    }
  }

  private managed(t: Record<string, Row[]>, raw: Row) {
    const record = recordSchema.parse(raw);
    t.management.push(encode("management", record));
    return record;
  }

  private aircraftYear(
    t: Record<string, Row[]>,
    n: number,
    blob: Id<"_storage">,
  ) {
    const aircraft = demoAircraft(n);
    this.aircraftUuids.push(aircraft.uuid);
    t.aircraft.push(aircraft);
    this.flightsOf(t, aircraft);
    this.maintenanceOf(t, aircraft, blob);
    this.componentsOf(t, aircraft);
    this.purchasingOf(t, aircraft);
  }

  private flightsOf(t: Record<string, Row[]>, a: Aircraft) {
    const step = (365 * DAY) / VOLUME.flights;
    for (let i = 0; i < VOLUME.flights; i++) {
      const start = this.end - (VOLUME.flights - i) * step;
      const flight = this.flight(a, i, start);
      t.flights.push(flight);
      this.audit(t, a, "flight.created", flight.uuid, start, flight);
      if (i % VOLUME.flightPlanEvery === 0)
        t.flightPlans.push(encode("flightPlans", this.flightPlan(a, start)));
      if (i % VOLUME.reportEvery === 3)
        t.discrepancies.push(this.report(a, flight, i));
    }
  }

  private flight(a: Aircraft, i: number, start: number) {
    // An earlier year's flights end where the next year's begin.
    const hobbsOff =
      a.currentHobbs + (i - this.yearsBack * VOLUME.flights) * HOUR;
    return {
      uuid: this.uuid(),
      aircraftUuid: a.uuid,
      authorId: this.users.pilot,
      pilotId: this.users.pilot,
      startTime: new Date(start).toISOString(),
      submittedAt: start + HOUR * 1000,
      status: "accepted",
      hobbsOff,
      hobbsOn: hobbsOff + HOUR,
      landings: 1,
      cycles: 1,
      origin: "KCHA",
      destination: "KAVL",
      operation: "Mission",
      flightRules: "VFR",
      remarks: i % 3 === 0 ? "Patient transfer with one attendant." : "",
      discrepancy:
        i % VOLUME.reportEvery === 3 ? "Landing light flickers." : "",
      fuel: { unit: "lb", start: 1800, added: 0, end: 1100 },
    };
  }

  private flightPlan(a: Aircraft, start: number) {
    return flightPlanSchema.parse({
      uuid: this.uuid(),
      version: 1,
      aircraftUuid: a.uuid,
      registration: a.registration,
      departureAt: new Date(start).toISOString().replace(".000Z", "Z"),
      origin: "KCHA",
      destination: "KAVL",
      alternate: "KTYS",
      durationMinutes: 60,
      cycles: 1,
      landings: 1,
      flightRules: "V",
      aircraftType: "C206",
      flightType: "G",
      speed: "N0140",
      level: "A080",
      route: "DCT",
      enduranceMinutes: 300,
      personsOnBoard: 2,
      pilotText: "Pilot",
      equipment: "SDFGR/S",
      otherInformation: "RMK/MEDEVAC",
      sourceName: "",
      sourceHash: this.uuid().replace(/-/g, "").padEnd(64, "0"),
      status: "proposed",
      createdAt: start - DAY,
    });
  }

  private report(a: Aircraft, flight: { uuid: string }, i: number) {
    const open =
      this.yearsBack === 0 && i >= VOLUME.flights - 3 * VOLUME.reportEvery;
    return {
      uuid: this.uuid(),
      aircraftUuid: a.uuid,
      flightUuid: flight.uuid,
      description: "Landing light flickers on taxi.",
      authorId: this.users.pilot,
      createdAt: this.end - (VOLUME.flights - i) * DAY,
      ...(open
        ? { status: "open" }
        : {
            status: "resolved",
            resolution: "Replaced lamp and cleaned socket contacts.",
            resolvedBy: this.users.admin,
            resolvedAt: this.end - DAY,
          }),
    };
  }

  private maintenanceOf(
    t: Record<string, Row[]>,
    a: Aircraft,
    blob: Id<"_storage">,
  ) {
    for (let w = 0; w < VOLUME.workOrders; w++) {
      const open = this.yearsBack === 0 && w === VOLUME.workOrders - 1;
      const order = this.workOrder(a, w, !open);
      t.workOrders.push(encode("workOrders", order));
      this.audit(t, a, "workOrder.save", order.uuid, order.recordedAt, order);
      t.costs.push(encode("costs", this.cost(a, order.uuid)));
      if (!open) t.workOrderFiles.push(this.file(blob, a, order.uuid, "work"));
      for (let j = 0; j < VOLUME.jobCardsPerWorkOrder; j++)
        this.jobCard(t, a, order.uuid, w * 100 + j, blob, w === 0 && j === 0);
    }
  }

  private jobCard(
    t: Record<string, Row[]>,
    a: Aircraft,
    workOrderUuid: string,
    n: number,
    blob: Id<"_storage">,
    archived: boolean,
  ) {
    const card = this.taskCard(a.uuid, workOrderUuid, n, true);
    const table = archived ? "archivedTaskCards" : "taskCards";
    t[table].push(encode(table, card));
    this.audit(t, a, "taskCard.save", card.uuid, card.updatedAt, card);
    if (n % VOLUME.evidenceEvery === 0)
      t.taskEvidence.push({
        ...this.file(blob, a, card.uuid, "card"),
        category: "photo",
      });
  }

  taskCard(
    aircraftUuid: string,
    workOrderUuid: string,
    n: number,
    done: boolean,
  ) {
    const at = this.end - (n % 365) * DAY;
    return taskCardSchema.parse({
      ...taskCardDefaults(aircraftUuid),
      uuid: this.uuid(),
      version: 3,
      createdBy: this.users.admin,
      createdAt: at,
      updatedAt: at,
      cardNumber: `JC-${n}${this.suffix}`,
      title: "Engine compartment inspection",
      workOrderUuid,
      description: "Inspect the engine compartment for leaks and security.",
      maintenanceReference: "Maintenance manual chapter 5-10-01",
      steps: STEPS.map((instruction, s) => ({
        uuid: this.uuid(),
        instruction,
        requiredResult: "No defects; within limits.",
        result: done ? "Satisfactory; no defects found." : "",
        measurementRequired: false,
        measurement: null,
        units: "",
        lowerLimit: null,
        upperLimit: null,
        signoffRequired: s === 0,
      })),
      status: done ? "completed" : "ready",
      actualWork: done ? "Completed IAW the maintenance manual." : "",
      technicianSignoff: null,
      inspectionSignoff: null,
      stepSignoffs: {},
    });
  }

  workOrder(a: Aircraft, w: number, completed: boolean) {
    const opened = this.end - (VOLUME.workOrders - w) * 30 * DAY;
    const reading = {
      registration: a.registration,
      make: a.make,
      model: a.model,
      serial: a.serial,
      totalSeconds: a.currentHobbs,
      hobbs: a.currentHobbs,
      tach: a.currentTach,
      meter: "hobbs",
      cycles: a.cycles,
    };
    return workOrderSchema.parse({
      uuid: this.uuid(),
      version: completed ? 6 : 4,
      number: `WO-${a.serial}-${w}${this.suffix}`,
      aircraftUuid: a.uuid,
      dateOpened: new Date(opened).toISOString().slice(0, 10),
      supervisor: "Chief inspector",
      scope: "100-hour inspection and rectification of reported discrepancies.",
      priority: "routine",
      status: completed ? "completed" : "in-progress",
      completionDate: completed
        ? new Date(opened + 5 * DAY).toISOString().slice(0, 10)
        : "",
      releaseOutcome: completed ? "Approved for return to service." : "",
      finalReview: "",
      recordedAt: opened,
      createdBy: this.users.admin,
      aircraft: reading,
      componentReadings: [],
      tasks: [],
    });
  }

  private cost(a: Aircraft, workOrderUuid: string) {
    return costRecordSchema.parse({
      version: 1,
      uuid: this.uuid(),
      programUuid: VOLUME_PROGRAM,
      kind: "workOrder",
      aircraftUuid: a.uuid,
      workOrderUuid,
      labor: [
        {
          uuid: this.uuid(),
          date: new Date(this.end - DAY).toISOString().slice(0, 10),
          technician: "Mechanic",
          minutes: 780,
          seconds: 13 * HOUR,
          rateCents: 9500,
          createdBy: this.users.admin,
          createdAt: this.end - DAY,
        },
      ],
      other: [],
      partUnitCosts: [],
    });
  }

  private file(
    blob: Id<"_storage">,
    a: Aircraft,
    owner: string,
    kind: "card" | "work",
  ) {
    return {
      ...(kind === "card" ? { taskCardUuid: owner } : { workOrderUuid: owner }),
      aircraftUuid: a.uuid,
      storageId: blob,
      name: `${kind}-${owner.slice(-6)}.pdf`,
      size: 2048,
      uploadedAt: this.end - DAY,
    };
  }

  private componentsOf(t: Record<string, Row[]>, a: Aircraft) {
    for (let i = 0; i < VOLUME.components; i++) {
      const component = this.managed(t, {
        uuid: this.uuid(),
        version: 1,
        programUuid: VOLUME_PROGRAM,
        kind: "component",
        aircraftUuid: a.uuid,
        componentType: "Magneto",
        manufacturer: "Slick",
        model: `M-${100 + i}`,
        partNumber: `PN-${3000 + i}`,
        serial: `SN-${a.serial}-${i}`,
        notes: "",
        trackTime: true,
        trackCycles: false,
        trackCalendar: false,
        installed: true,
        installedDate: "2025-01-01",
        installedSeconds: a.currentHobbs,
        installedCycles: 0,
        timeSinceNew: (300 + i) * HOUR,
        timeSinceOverhaul: null,
        timeSinceRepair: null,
        cyclesSinceNew: 0,
        serviceDaysBase: 0,
      });
      if (i % 5 === 0) this.requirement(t, a, component.uuid);
    }
    this.inspectionsOf(t, a);
    this.adsOf(t, a);
  }

  private requirement(t: Record<string, Row[]>, a: Aircraft, uuid: string) {
    this.managed(t, {
      uuid: this.uuid(),
      version: 1,
      programUuid: VOLUME_PROGRAM,
      kind: "componentRequirement",
      componentUuid: uuid,
      aircraftUuid: a.uuid,
      requirementType: "Life Limits",
      description: "Replace at life limit",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      warningCalendarMonths: 1,
      warningSeconds: 25 * HOUR,
      warningCycles: 10,
      dueDate: "2027-06-01",
    });
  }

  private inspectionsOf(t: Record<string, Row[]>, a: Aircraft) {
    for (let i = 0; i < VOLUME.inspections; i++)
      t.inspections.push(
        inspectionSchema.parse({
          uuid: this.uuid(),
          version: 2,
          programUuid: VOLUME_PROGRAM,
          aircraftUuid: a.uuid,
          reference: `100-hour inspection item ${i + 1}`,
          description: "Inspect for leaks, chafing and security.",
          materials: "",
          archived: false,
          intervalSeconds: 100 * HOUR,
          lastSeconds: a.currentHobbs - 20 * HOUR,
          lastDate: "2026-10-20",
          dueSeconds: a.currentHobbs + 80 * HOUR,
        }),
      );
  }

  private adsOf(t: Record<string, Row[]>, a: Aircraft) {
    for (let d = 0; d < VOLUME.ads; d++) {
      const ad = adSchema.parse({
        uuid: this.uuid(),
        version: 2,
        programUuid: VOLUME_PROGRAM,
        aircraftUuid: a.uuid,
        componentUuid: "",
        applicability: "Previously Complied With (PCW)",
        reason: "Complied with at manufacture per the aircraft records.",
        history: [],
        sourceHistory: [],
        reviewRequired: false,
        updatedAt: this.end - 30 * DAY,
        source: {
          amendment: "",
          issued: "",
          effective: "",
          supersededBy: "",
          url: "",
          source: "Test entry (not an FAA directive)",
          section: "Airframe",
          make: a.make,
          model: a.model,
          sourceNotes: "",
          recurring: "No",
          number: `2010-VT-${d + 1}`,
          subject: "Seat rail and stop inspection",
        },
        tasks: [],
      });
      t.airworthiness.push(encode("airworthiness", ad));
    }
  }

  private purchasingOf(t: Record<string, Row[]>, a: Aircraft) {
    for (let n = 0; n < VOLUME.partsRequests; n++)
      t.partsRequests.push(
        encode("partsRequests", this.partsRequest(a, this.stock[n])),
      );
    for (let n = 0; n < VOLUME.purchaseOrders; n++)
      t.purchaseOrders.push(
        encode("purchaseOrders", this.purchaseOrder(a, this.stock[n])),
      );
  }

  private partsRequest(a: Aircraft, stock: Generator["stock"][number]) {
    const at = this.end - 10 * DAY;
    const line = this.uuid();
    return partsRequestSchema.parse({
      ...REQUEST_TEXT,
      uuid: this.uuid(),
      version: 3,
      source: { kind: "stock", uuid: stock.uuid, workOrderUuid: "" },
      lines: [
        {
          uuid: line,
          partNumber: stock.partNumber,
          description: "Oil filter",
          quantity: 1,
          quotedCents: 2495,
        },
      ],
      aircraftUuid: a.uuid,
      sourceLabel: stock.partNumber,
      aircraftRegistration: a.registration,
      aircraftSerial: a.serial,
      aircraftModel: a.model,
      number: `PR-${a.serial}-${line.slice(-4)}${this.suffix}`,
      requesterId: this.users.admin,
      createdAt: at,
      updatedAt: at,
      reservations: [],
      issues: [
        {
          lineUuid: line,
          stockUuid: stock.uuid,
          quantity: 1,
          at,
          actorId: this.users.admin,
        },
      ],
      history: [],
    });
  }

  private purchaseOrder(a: Aircraft, stock: Generator["stock"][number]) {
    const at = this.end - 20 * DAY;
    return poSchema.parse({
      uuid: this.uuid(),
      version: 2,
      programUuid: VOLUME_PROGRAM,
      number: `PO-${a.serial}-${this.next}${this.suffix}`,
      vendor: "Example Aviation Supply",
      vendorContact: "orders@example.test",
      shipTo: "Hangar 4",
      expectedDate: "2026-11-20",
      currency: "USD",
      shippingCents: 1500,
      notes: "",
      phase: "issued",
      revision: 0,
      createdAt: at,
      updatedAt: at,
      issuedAt: at,
      lines: [
        {
          uuid: this.uuid(),
          stockUuid: stock.uuid,
          locationUuid: stock.locationUuid,
          partNumber: stock.partNumber,
          description: "Oil filter",
          quantity: 4,
          unitCents: 2495,
          kind: "part",
          aircraftUuid: a.uuid,
        },
      ],
      shipments: [],
      receipts: [],
      history: [],
    });
  }

  private audit(
    t: Record<string, Row[]>,
    a: Aircraft,
    action: string,
    entityUuid: string,
    at: number,
    after: unknown,
  ) {
    t.audit.push({
      uuid: this.uuid(),
      programUuid: VOLUME_PROGRAM,
      aircraftUuid: a.uuid,
      actorId: this.users.admin,
      at,
      action,
      entityUuid,
      after: JSON.stringify(after),
    });
  }
}
