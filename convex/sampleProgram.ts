/**
 * Responsibility: Provisions the fictional SAMPLE training program on request:
 *   four aircraft with linked records, then their example documents.
 * Layer: Server. Internal mutations run by hand (docs/sample-program.md);
 *   nothing seeds automatically.
 * Dependencies: convex/access, convex/defaultGroups, convex/collections,
 *   convex/recordNumbers, src/domain (management, workOrders, taskCards,
 *   airworthiness, checklists, inspectionTemplates, flightPlans,
 *   purchaseOrders).
 *
 * Every record says SAMPLE and fictional, so none can pass for a real
 * maintenance record, certificate, order or FAA directive.
 */
import { writeAudit } from "./access";
import { ensureDefaultGroups } from "./defaultGroups";
import { encode, flightColumns } from "./collections";
import { syncRecordNumber } from "./recordNumbers";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import { recordSchema, inspectionSchema } from "../src/domain/management";
import {
  workOrderSchema,
  newWorkTask,
  type WorkTask,
} from "../src/domain/workOrders";
import { taskCardSchema, taskCardDefaults } from "../src/domain/taskCards";
import { blankAD, adSchema } from "../src/domain/airworthiness";
import {
  emptyChecklist,
  checklistRecordSchema,
} from "../src/domain/checklists";
import {
  emptyTemplate,
  inspectionTemplateSchema,
} from "../src/domain/inspectionTemplates";
import { flightPlanSchema, type FlightPlan } from "../src/domain/flightPlans";
import { poSchema } from "../src/domain/purchaseOrders";

/** The sample program's fixed uuid, which makes a repeat seed a no-op. */
export const PROGRAM = "sample-aviation-program-v1";
const PROGRAM_NAME = "SAMPLE — Hope Aviation Training";
const NOTE =
  "SAMPLE ONLY — fictional training data; not approved for flight or maintenance.";
const HOUR = 3600;
const DAY_MS = 86_400_000;
const NOON = "T12:00:00.000Z";
// The four example PDFs, one for each sample aircraft.
const SAMPLE_PDF_COUNT = 4;

// One row per sample aircraft; together they show each state the screens
// have: work orders open to awaiting approval, stock in and out, POs from
// draft to shipped, a twin.
const FLEET = [
  {
    make: "Cessna",
    model: "172S",
    twin: false,
    turbine: false,
    hours: 1200,
    cycles: 800,
    location: "SAMPLE Main Parts Store",
    part: "SAMPLE-FILTER",
    partDescription: "SAMPLE oil filter",
    supply: false,
    quantity: 8,
    cost: 35,
    dueHours: 10,
    dueDays: 7,
    status: "open",
    phase: "draft",
    shipped: 0,
    origin: "KCHA",
    destination: "KAVL",
    discrepancy: "Landing light intermittent",
  },
  {
    make: "Mooney",
    model: "M20J",
    twin: false,
    turbine: false,
    hours: 2000,
    cycles: 1100,
    location: "SAMPLE Line Maintenance",
    part: "SAMPLE-TIRE",
    partDescription: "SAMPLE main tire",
    supply: false,
    quantity: 0,
    cost: 180,
    dueHours: 20,
    dueDays: 14,
    status: "parts-delay",
    phase: "issued",
    shipped: 0,
    origin: "KAVL",
    destination: "KTYS",
    discrepancy: "Seat trim loose",
  },
  {
    make: "Cessna",
    model: "441",
    twin: true,
    turbine: true,
    hours: 2800,
    cycles: 1400,
    location: "SAMPLE Engine Shop",
    part: "SAMPLE-LAMP",
    partDescription: "SAMPLE landing lamp",
    supply: false,
    quantity: 2,
    cost: 65,
    dueHours: 50,
    dueDays: 45,
    status: "in-progress",
    phase: "issued",
    shipped: 2,
    origin: "KTYS",
    destination: "KTRI",
    discrepancy: "Cabin reading light inoperative",
  },
  {
    make: "Cessna",
    model: "208B",
    twin: false,
    turbine: true,
    hours: 3600,
    cycles: 1700,
    location: "SAMPLE Remote Base",
    part: "SAMPLE-OIL",
    partDescription: "SAMPLE engine oil quart",
    supply: true,
    quantity: 24,
    cost: 12,
    dueHours: 100,
    dueDays: 90,
    status: "awaiting-approval",
    phase: "issued",
    shipped: 4,
    origin: "KTRI",
    destination: "KCHA",
    discrepancy: "Inspection panel fastener missing",
  },
] as const;

const SAMPLE_GROUPS = [
  { name: "Sample pilots", permissions: ["read", "flight", "discrepancy"] },
  {
    name: "Sample maintenance",
    permissions: ["read", "maintenance", "resolve"],
  },
  { name: "Sample dispatch", permissions: ["read", "flight", "discrepancy"] },
  { name: "Sample observers", permissions: ["read"] },
] as const;

// Attaching finds each aircraft's records by this id.
const aircraftId = (n: number) => `sample-aircraft-${n}`;
const AIRCRAFT_IDS = FLEET.map((_, i) => aircraftId(i + 1));

type FleetRow = (typeof FLEET)[number];

interface Seeding {
  ctx: MutationCtx;
  userId: Id<"users">;
  now: number;
  /** The UTC date `offset` days from now. */
  day(offset: number): string;
}

// One sample aircraft's row, its number (1–4) and the ids its records share.
interface Sample {
  row: FleetRow;
  n: number;
  aircraftUuid: string;
  registration: string;
  seconds: number;
  locationUuid: string;
  stockUuid: string;
  componentUuid: string;
  inspectionUuid: string;
  workOrderUuid: string;
  cardUuid: string;
  poUuid: string;
}

/**
 * Creates the sample program, unless it exists: its groups, and four aircraft
 * each with inventory, engines, an inspection with a work order and job card,
 * a template, a checklist, flights, a discrepancy, an AD example and a PO.
 * Audits the default groups it adds and `sample.created` per aircraft. An
 * administrator without an active program is switched to it.
 *
 * @param email - The administrator's email; the change-log rows name them.
 * @returns The program's uuid, and `created: false` when it already existed.
 * @throws {Error} "An active administrator is required." before any write.
 */
export const seed = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await userByEmail(ctx, email);
    if (!user?.isAdmin || !user.active)
      throw new Error("An active administrator is required.");
    if (await findProgram(ctx)) return { programUuid: PROGRAM, created: false };
    const now = Date.now();
    const day = (offset: number) =>
      new Date(now + offset * DAY_MS).toISOString().slice(0, 10);
    const s: Seeding = { ctx, userId: user._id, now, day };
    await insertProgram(s);
    for (const [i, row] of FLEET.entries()) await seedAircraft(s, row, i + 1);
    if (!user.activeProgramUuid)
      await ctx.db.patch(user._id, { activeProgramUuid: PROGRAM });
    return { programUuid: PROGRAM, created: true };
  },
});

/**
 * Files one stored example PDF per sample aircraft on its manuals, its job
 * card's evidence, its stock item, its work order and its PO; the four areas
 * share the file. Nothing is attached twice.
 *
 * @param files - Four stored PDFs, in aircraft order.
 * @param email - An administrator's email.
 * @returns `created: false` when the documents were already attached.
 * @throws {Error} "Exactly four example PDFs are required."; "Administrator
 *   required."; "Seed the sample program first."; "Sample links are missing."
 *   when an aircraft lacks its work order, job card or PO.
 */
export const attach = internalMutation({
  args: {
    files: v.array(v.object({ storageId: v.id("_storage"), size: v.number() })),
    email: v.string(),
  },
  handler: async (ctx, { files, email }) => {
    if (files.length !== SAMPLE_PDF_COUNT)
      throw new Error("Exactly four example PDFs are required.");
    const user = await userByEmail(ctx, email);
    if (!user?.isAdmin) throw new Error("Administrator required.");
    if (!(await findProgram(ctx)))
      throw new Error("Seed the sample program first.");
    if (await documentsAttached(ctx)) return { created: false };
    const orders = await ctx.db
      .query("purchaseOrders")
      .withIndex("program", (q) => q.eq("programUuid", PROGRAM))
      .collect();
    for (const [i, file] of files.entries())
      await attachDocuments(ctx, { user, orders, file, n: i + 1 });
    return { created: true };
  },
});

function userByEmail(ctx: MutationCtx, email: string) {
  return ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .unique();
}

function findProgram(ctx: MutationCtx) {
  return ctx.db
    .query("programs")
    .withIndex("uuid", (q) => q.eq("uuid", PROGRAM))
    .unique();
}

async function insertProgram({ ctx, userId }: Seeding) {
  await ctx.db.insert("programs", {
    uuid: PROGRAM,
    version: 1,
    name: PROGRAM_NAME,
    address: "Sample Hangar, Example Airfield (fictional)",
    email: "operations@example.test",
    contactName: "Sample Operations Coordinator",
    website: "https://example.test",
  });
  await ensureDefaultGroups(ctx, PROGRAM, userId);
  for (const group of SAMPLE_GROUPS)
    await ctx.db.insert("groups", {
      programUuid: PROGRAM,
      name: group.name,
      aircraftIds: AIRCRAFT_IDS,
      permissions: [...group.permissions],
    });
}

async function seedAircraft(s: Seeding, row: FleetRow, n: number) {
  const a = sampleOf(row, n);
  await insertAircraft(s, a);
  await insertInventory(s, a);
  await insertEngines(s, a);
  await insertInspectionWork(s, a);
  await insertTemplate(s, a);
  await insertChecklist(s, a);
  await insertFlights(s, a);
  await insertDiscrepancy(s, a);
  await insertAD(s, a);
  await insertPurchaseOrder(s, a);
  await writeAudit(s.ctx, {
    uuid: crypto.randomUUID(),
    programUuid: PROGRAM,
    aircraftUuid: a.aircraftUuid,
    actorId: s.userId,
    at: s.now,
    action: "sample.created",
    entityUuid: a.aircraftUuid,
    reason: NOTE,
    after: JSON.stringify({
      workOrderUuid: a.workOrderUuid,
      cardUuid: a.cardUuid,
      poUuid: a.poUuid,
    }),
  });
}

function sampleOf(row: FleetRow, n: number): Sample {
  return {
    row,
    n,
    aircraftUuid: aircraftId(n),
    registration: `SAMPLE-${n}`,
    seconds: row.hours * HOUR,
    locationUuid: `sample-location-${n}`,
    stockUuid: `sample-stock-${n}`,
    componentUuid: `sample-component-${n}`,
    inspectionUuid: `sample-inspection-${n}`,
    workOrderUuid: crypto.randomUUID(),
    cardUuid: crypto.randomUUID(),
    poUuid: crypto.randomUUID(),
  };
}

// The counters stand one sample flight (an hour, one cycle) past the
// baseline, so the seeded flight reconciles with them.
async function insertAircraft({ ctx, day }: Seeding, a: Sample) {
  const { make, model, twin, turbine, cycles } = a.row;
  await ctx.db.insert("aircraft", {
    uuid: a.aircraftUuid,
    registration: a.registration,
    make,
    model,
    serial: `SAMPLE-SERIAL-${a.n}`,
    program: PROGRAM_NAME,
    programUuid: PROGRAM,
    meter: "hobbs" as const,
    adjustmentSeconds: 0,
    baselineHobbs: a.seconds,
    baselineTach: a.seconds,
    baselineCycles: cycles,
    baselineLandings: cycles,
    currentHobbs: a.seconds + HOUR,
    currentTach: a.seconds + HOUR,
    cycles: cycles + 1,
    landings: cycles + 1,
    version: 1,
    twin,
    turbine,
    latestFlightAt: day(-2) + NOON,
    operationalStatus: "unknown" as const,
  });
}

async function insertManaged(ctx: MutationCtx, raw: unknown) {
  const record = recordSchema.parse(raw);
  await ctx.db.insert("management", {
    uuid: record.uuid,
    programUuid: PROGRAM,
    kind: record.kind,
    ...("aircraftUuid" in record ? { aircraftUuid: record.aircraftUuid } : {}),
    payload: JSON.stringify(record),
  });
}

async function insertInventory({ ctx }: Seeding, a: Sample) {
  const { row } = a;
  await insertManaged(ctx, {
    uuid: a.locationUuid,
    version: 1,
    programUuid: PROGRAM,
    kind: "location",
    name: row.location,
    address: "Fictional location for training",
    contact: "stores@example.test",
  });
  await insertManaged(ctx, {
    uuid: a.stockUuid,
    version: 1,
    programUuid: PROGRAM,
    kind: "stock",
    partNumber: row.part,
    alternates: "",
    description: row.partDescription,
    category: row.supply ? "supply" : "part",
    oil: row.supply || undefined,
    condition: "new",
    locationUuid: a.locationUuid,
    quantity: row.quantity,
    minimum: 4,
    vendor: `SAMPLE Vendor ${a.n}`,
    cost: row.cost,
  });
}

// An installed engine and a spare in stores, with one requirement and the
// baseline movement that set up its counters.
async function insertEngines(s: Seeding, a: Sample) {
  const engine = sampleEngine(s, a);
  await insertManaged(s.ctx, engine);
  await insertManaged(s.ctx, {
    ...engine,
    uuid: `sample-spare-${a.n}`,
    aircraftUuid: "",
    installed: false,
    installedDate: undefined,
    installPosition: undefined,
    locationUuid: a.locationUuid,
    serial: `SAMPLE-SPARE-SN-${a.n}`,
    notes: NOTE + " Spare in inventory.",
    incomingTag: { condition: "overhauled" },
  });
  await insertManaged(s.ctx, engineRequirement(a));
  await insertManaged(s.ctx, engineBaseline(s, a));
}

function sampleEngine({ day }: Seeding, a: Sample) {
  return {
    uuid: a.componentUuid,
    version: 1,
    programUuid: PROGRAM,
    kind: "component",
    aircraftUuid: a.aircraftUuid,
    componentType: "Engine",
    partNumber: `SAMPLE-ENGINE-${a.n}`,
    serial: `SAMPLE-ENG-SN-${a.n}`,
    manufacturer: a.row.make,
    model: `SAMPLE ${a.row.model} engine`,
    notes: NOTE,
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedDate: day(-365),
    installPosition: "MAIN",
    installedSeconds: a.seconds,
    installedCycles: a.row.cycles,
    timeSinceNew: 500 * HOUR,
    timeSinceOverhaul: 100 * HOUR,
    timeSinceRepair: null,
    cyclesSinceNew: 400,
    serviceDaysBase: 0,
  };
}

function engineRequirement(a: Sample) {
  return {
    uuid: `sample-requirement-${a.n}`,
    version: 1,
    programUuid: PROGRAM,
    kind: "componentRequirement",
    componentUuid: a.componentUuid,
    aircraftUuid: a.aircraftUuid,
    requirementType: "Inspection Requirement",
    description: "SAMPLE engine condition review",
    notes: NOTE,
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "FROM_LAST_COMPLIED",
    cycleLimitMode: "FROM_LAST_COMPLIED",
    intervalSeconds: 100 * HOUR,
    lastSeconds: 450 * HOUR,
    dueSeconds: 550 * HOUR,
    warningCalendarMonths: 1,
    warningSeconds: 30 * HOUR,
    warningCycles: 30,
    requiredParts: [
      { locationUuid: a.locationUuid, stockUuid: a.stockUuid, quantity: 1 },
    ],
  };
}

function engineBaseline({ day, userId, now }: Seeding, a: Sample) {
  return {
    uuid: `sample-baseline-${a.n}`,
    version: 1,
    programUuid: PROGRAM,
    kind: "componentMovement",
    componentUuid: a.componentUuid,
    aircraftUuid: a.aircraftUuid,
    action: "BASELINE",
    date: day(-365),
    timeSinceNew: 500 * HOUR,
    timeSinceOverhaul: 100 * HOUR,
    timeSinceRepair: null,
    cycles: 400,
    serviceDays: 0,
    note: NOTE + " Initial setup baseline; not an installation certification.",
    actorId: userId,
    at: now,
  };
}

// The inspection, a work order for it, and a job card on that order's task.
async function insertInspectionWork(s: Seeding, a: Sample) {
  const inspection = inspectionSchema.parse({
    uuid: a.inspectionUuid,
    version: 1,
    programUuid: PROGRAM,
    aircraftUuid: a.aircraftUuid,
    reference: `SAMPLE inspection ${a.n}`,
    description: NOTE + " Example scheduled condition inspection.",
    dueSeconds: a.seconds + a.row.dueHours * HOUR,
    dueDate: s.day(a.row.dueDays),
    intervalSeconds: 100 * HOUR,
    materials: "Sample parts only",
    archived: false,
    requiredParts: [
      { locationUuid: a.locationUuid, stockUuid: a.stockUuid, quantity: 2 },
    ],
  });
  await s.ctx.db.insert("inspections", inspection);
  const task = newWorkTask(
    { kind: "inspection", uuid: a.inspectionUuid },
    inspection.description,
  );
  await insertWorkOrder(s, a, task);
  await insertJobCard(s, a, task);
}

async function insertWorkOrder(s: Seeding, a: Sample, task: WorkTask) {
  const order = workOrderSchema.parse({
    uuid: a.workOrderUuid,
    version: 1,
    number: `SAMPLE-WO-${a.n}`,
    aircraftUuid: a.aircraftUuid,
    dateOpened: s.day(-1),
    supervisor: "Sample Maintenance Coordinator",
    scope: NOTE,
    priority: "routine",
    status: a.row.status,
    completionDate: "",
    releaseOutcome: "",
    finalReview: "",
    recordedAt: s.now,
    createdBy: s.userId,
    aircraft: orderAircraft(a),
    componentReadings: [],
    tasks: [task],
  });
  const row = encode("workOrders", order);
  await s.ctx.db.insert("workOrders", row);
  await syncRecordNumber(s.ctx, "workOrders", row);
}

// The aircraft as the work order recorded it when opened.
function orderAircraft(a: Sample) {
  return {
    registration: a.registration,
    make: a.row.make,
    model: a.row.model,
    serial: `SAMPLE-SERIAL-${a.n}`,
    totalSeconds: a.seconds + HOUR,
    hobbs: a.seconds + HOUR,
    tach: a.seconds + HOUR,
    meter: "hobbs",
    cycles: a.row.cycles + 1,
  };
}

async function insertJobCard(
  { ctx, now, userId }: Seeding,
  a: Sample,
  task: WorkTask,
) {
  const card = taskCardSchema.parse({
    ...taskCardDefaults(a.aircraftUuid),
    uuid: a.cardUuid,
    version: 1,
    cardNumber: `SAMPLE-JC-${a.n}`,
    title: "SAMPLE condition inspection job card",
    description: NOTE,
    inspectionUuid: a.inspectionUuid,
    workOrderUuid: a.workOrderUuid,
    workTaskUuid: task.uuid,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  });
  const row = encode("taskCards", card);
  await ctx.db.insert("taskCards", row);
  await syncRecordNumber(ctx, "taskCards", row);
}

async function insertTemplate({ ctx }: Seeding, { row }: Sample) {
  const template = inspectionTemplateSchema.parse({
    ...emptyTemplate(),
    version: 1,
    programUuid: PROGRAM,
    name: `SAMPLE ${row.model} inspection template`,
    group: "SAMPLE training",
    description: NOTE,
    hours: 100,
    applicability: {
      kind: "aircraft",
      manufacturer: row.make,
      model: row.model,
      partNumber: "",
    },
    tasks: [
      {
        itemCode: "SAMPLE-01",
        instruction: NOTE + " Review this example record.",
        applicability: "Training only",
      },
    ],
  });
  await ctx.db.insert("inspectionTemplates", {
    uuid: template.uuid,
    programUuid: PROGRAM,
    payload: JSON.stringify(template),
  });
}

async function insertChecklist({ ctx, now, userId }: Seeding, a: Sample) {
  const doc = emptyChecklist();
  doc.payload.metadata = {
    name: `SAMPLE ${a.row.model} checklist`,
    detail: NOTE,
    tailNumber: a.registration,
  };
  doc.payload.groups[0].items = [
    {
      objectId: crypto.randomUUID(),
      title: "SAMPLE Training",
      items: ["Preflight", "Engine Start", "Before Takeoff", "Shutdown"].map(
        checklistSection,
      ),
    },
  ];
  const checklist = checklistRecordSchema.parse({
    uuid: crypto.randomUUID(),
    version: 1,
    programUuid: PROGRAM,
    aircraftUuid: a.aircraftUuid,
    sourceName: "Sample training checklist",
    updatedAt: now,
    updatedBy: userId,
    document: doc,
  });
  await ctx.db.insert("checklists", {
    uuid: checklist.uuid,
    programUuid: PROGRAM,
    aircraftUuid: a.aircraftUuid,
    payload: JSON.stringify(checklist),
  });
}

function checklistSection(title: string) {
  return {
    objectId: crypto.randomUUID(),
    title,
    items: [
      { objectId: crypto.randomUUID(), type: "comment" as const, title: NOTE },
      {
        objectId: crypto.randomUUID(),
        title: "Review sample screen",
        detail:
          "Training only — use approved aircraft procedures for actual operations.",
      },
    ],
  };
}

// A past plan with the flight that used it, then a future plan.
async function insertFlights(s: Seeding, a: Sample) {
  const past = await insertFlightPlan(s, a, -2, 1);
  const flight = sampleFlight(s, a, past);
  await s.ctx.db.insert("flights", { ...flight, ...flightColumns(flight) });
  await insertFlightPlan(s, a, a.n, 2);
}

async function insertFlightPlan(
  s: Seeding,
  a: Sample,
  offset: number,
  sequence: number,
) {
  const plan = flightPlanSchema.parse(samplePlan(s, a, offset, sequence));
  await s.ctx.db.insert("flightPlans", {
    uuid: plan.uuid,
    aircraftUuid: a.aircraftUuid,
    payload: JSON.stringify(plan),
  });
  return plan;
}

// `sequence` makes each plan's source hash distinct across the fleet.
function samplePlan(
  { day, now }: Seeding,
  a: Sample,
  offset: number,
  sequence: number,
) {
  return {
    uuid: crypto.randomUUID(),
    version: 1,
    aircraftUuid: a.aircraftUuid,
    registration: a.registration,
    departureAt: day(offset) + NOON,
    origin: a.row.origin,
    destination: a.row.destination,
    alternate: "",
    durationMinutes: 60,
    cycles: 1,
    landings: 1,
    flightRules: "V",
    aircraftType: a.row.model,
    flightType: "G",
    speed: "N0120",
    level: "VFR",
    route: "DCT",
    pilotText: "Sample pilot",
    equipment: "",
    otherInformation: NOTE,
    sourceName: "Sample training plan",
    sourceHash: String((a.n - 1) * 2 + sequence).padStart(64, "0"),
    status: "proposed",
    createdAt: now,
  };
}

function sampleFlight(
  { userId, now }: Seeding,
  a: Sample,
  plan: FlightPlan,
): WithoutSystemFields<Doc<"flights">> {
  const engines = a.row.twin
    ? (["left", "right"] as const)
    : (["single"] as const);
  return {
    uuid: `sample-flight-${a.n}`,
    aircraftUuid: a.aircraftUuid,
    flightPlanUuid: plan.uuid,
    authorId: userId,
    pilotId: userId,
    startTime: plan.departureAt,
    submittedAt: now,
    status: "accepted",
    // `*Off` is where the flight started (the baseline) and `*On` where it
    // ended (the aircraft's current reading), as an accepted flight is stored.
    hobbsOff: a.seconds,
    hobbsOn: a.seconds + HOUR,
    tachOff: a.seconds,
    tachOn: a.seconds + HOUR,
    cycles: 1,
    landings: 1,
    origin: plan.origin,
    destination: plan.destination,
    operation: "Private",
    flightRules: "VFR",
    remarks: NOTE,
    discrepancy: "",
    fuel: { unit: "US gal", start: 50, added: 0, end: 35 },
    oil: engines.map((engine) => ({
      engine,
      unit: "US qt",
      start: 7,
      added: 0,
    })),
  };
}

async function insertDiscrepancy({ ctx, userId, now }: Seeding, a: Sample) {
  await ctx.db.insert("discrepancies", {
    uuid: `sample-discrepancy-${a.n}`,
    aircraftUuid: a.aircraftUuid,
    flightUuid: `sample-flight-${a.n}`,
    description: NOTE + " " + a.row.discrepancy,
    status: "open",
    authorId: userId,
    createdAt: now,
    requiredParts: [
      { locationUuid: a.locationUuid, stockUuid: a.stockUuid, quantity: 1 },
    ],
  });
}

// The example is checked by its schema but stored as built.
async function insertAD({ ctx, now }: Seeding, a: Sample) {
  const ad = blankAD(a.aircraftUuid);
  ad.version = 1;
  ad.programUuid = PROGRAM;
  ad.updatedAt = now;
  ad.source.number = `SAMPLE-NOT-FAA-${a.n}`;
  ad.source.subject = NOTE;
  ad.source.source = "Fictional training example — not an FAA directive";
  ad.source.make = a.row.make;
  ad.source.model = a.row.model;
  ad.reason = NOTE;
  adSchema.parse(ad);
  await ctx.db.insert("airworthiness", {
    uuid: ad.uuid,
    aircraftUuid: a.aircraftUuid,
    programUuid: PROGRAM,
    payload: JSON.stringify(ad),
  });
}

async function insertPurchaseOrder(s: Seeding, a: Sample) {
  const po = poSchema.parse(samplePurchaseOrder(s, a));
  await s.ctx.db.insert("purchaseOrders", encode("purchaseOrders", po));
}

function samplePurchaseOrder(s: Seeding, a: Sample) {
  const lineUuid = crypto.randomUUID();
  const { phase, shipped } = a.row;
  return {
    uuid: a.poUuid,
    version: 1,
    programUuid: PROGRAM,
    number: `SAMPLE-PO-${a.n}`,
    vendor: `SAMPLE Vendor ${a.n}`,
    vendorContact: "sales@example.test",
    shipTo: "Sample Hangar — fictional address",
    expectedDate: s.day(7),
    currency: "USD",
    shippingCents: 0,
    notes: NOTE,
    phase,
    revision: 0,
    createdAt: s.now,
    updatedAt: s.now,
    ...(phase === "issued" ? { issuedAt: s.now } : {}),
    lines: [purchaseOrderLine(a, lineUuid)],
    shipments: shipped ? [shipment(s, a, lineUuid, shipped)] : [],
    receipts: [],
    history: [
      {
        at: s.now,
        actorId: s.userId,
        action: "sample.created",
        reason: NOTE,
        requestUuid: crypto.randomUUID(),
        detail: "Fictional purchase order; no order was placed.",
      },
    ],
  };
}

function purchaseOrderLine(a: Sample, lineUuid: string) {
  return {
    uuid: lineUuid,
    stockUuid: a.stockUuid,
    locationUuid: a.locationUuid,
    partNumber: a.row.part,
    description: "SAMPLE replacement parts",
    quantity: 4,
    unitCents: 3500,
    kind: a.row.supply ? "supply" : "part",
    inspectionUuid: a.inspectionUuid,
    aircraftUuid: a.aircraftUuid,
    workOrderUuid: a.workOrderUuid,
  };
}

function shipment(
  { day }: Seeding,
  a: Sample,
  lineUuid: string,
  quantity: number,
) {
  return {
    uuid: crypto.randomUUID(),
    date: day(0),
    carrier: "SAMPLE carrier",
    tracking: `SAMPLE-TRACK-${a.n}`,
    lines: [{ lineUuid, quantity }],
  };
}

async function documentsAttached(ctx: MutationCtx) {
  const first = await ctx.db
    .query("manuals")
    .withIndex("uuid", (q) => q.eq("uuid", "sample-manual-1"))
    .unique();
  return first !== null;
}

interface Attaching {
  user: Doc<"users">;
  orders: Doc<"purchaseOrders">[];
  file: { storageId: Id<"_storage">; size: number };
  n: number;
}

// One PDF per area; the job card's evidence, the stock item's, the work
// order's and the PO's files all point at the stored file the manual holds.
async function attachDocuments(ctx: MutationCtx, at: Attaching) {
  const { file, n } = at;
  const name = `SAMPLE-training-document-${n}.pdf`;
  const type = "application/pdf";
  const uploadedAt = Date.now();
  const stored = {
    storageId: file.storageId,
    name,
    size: file.size,
    uploadedAt,
  };
  const { wo, card, po } = await findSampleLinks(ctx, at);
  await insertManual(ctx, at, name, uploadedAt);
  await ctx.db.insert("taskEvidence", {
    ...stored,
    taskCardUuid: card.uuid,
    aircraftUuid: card.aircraftUuid,
    category: "supporting-document",
  });
  await ctx.db.insert("inventoryFiles", {
    ...stored,
    stockUuid: `sample-stock-${n}`,
    type,
  });
  await ctx.db.insert("workOrderFiles", {
    ...stored,
    workOrderUuid: wo.uuid,
    aircraftUuid: wo.aircraftUuid,
  });
  await ctx.db.insert("poFiles", {
    ...stored,
    poUuid: po.uuid,
    programUuid: PROGRAM,
    type,
  });
}

async function insertManual(
  ctx: MutationCtx,
  { user, file, n }: Attaching,
  filename: string,
  uploadedAt: number,
) {
  await ctx.db.insert("manuals", {
    uuid: `sample-manual-${n}`,
    aircraftUuid: aircraftId(n),
    title: `SAMPLE training reference ${n}`,
    documentNumber: `SAMPLE-DOC-${n}`,
    revision: "Training only",
    revisionDate: new Date(uploadedAt).toISOString().slice(0, 10),
    filename,
    size: file.size,
    pageCount: 1,
    storageId: file.storageId,
    uploadedAt,
    uploadedBy: user._id,
  });
}

async function findSampleLinks(ctx: MutationCtx, { orders, n }: Attaching) {
  const aircraftUuid = aircraftId(n);
  const wo = await ctx.db
    .query("workOrders")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .first();
  const card = await ctx.db
    .query("taskCards")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .first();
  const po = orders.find(
    (p) => JSON.parse(p.payload).lines[0].aircraftUuid === aircraftUuid,
  );
  if (!wo || !card || !po) throw new Error("Sample links are missing.");
  return { wo, card, po };
}
