/**
 * Responsibility: Seeds a convex-test database with the demo program and one
 *   or two stored rows in every payload collection, written as the app
 *   writes them.
 * Layer: Test. Fixture for convex-test suites; never shipped in the build.
 * Dependencies: convex/_generated (types), src/data/demo.ts, src/domain
 *   stored-record schemas and builders.
 *
 * Some payloads leave out fields their schema defaults, as rows written by an
 * earlier version would, so decoding them is not a plain JSON.parse. Rows on
 * demo-182 sit outside the member's group, so the two views differ.
 */
import type { MutationCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { demoSnapshot } from "../../src/data/demo";
import { blankAD, adSchema } from "../../src/domain/airworthiness";
import {
  emptyChecklist,
  checklistRecordSchema,
} from "../../src/domain/checklists";
import { costRecordSchema } from "../../src/domain/costs";
import { emptyMonitor } from "../../src/domain/faa";
import { flightPlanSchema } from "../../src/domain/flightPlans";
import {
  emptyTemplate,
  inspectionTemplateSchema,
} from "../../src/domain/inspectionTemplates";
import { recordSchema } from "../../src/domain/management";
import { poSchema } from "../../src/domain/purchaseOrders";
import { taskCardDefaults, taskCardSchema } from "../../src/domain/taskCards";
import { workOrderSchema } from "../../src/domain/workOrders";

export const PROGRAM = "demo-program";
const [N206, N208, N182] = demoSnapshot().aircraft.map((a) => a.uuid);

/** The accounts a seeded database signs in as. */
export interface SeededAccounts {
  admin: { id: Id<"users">; subject: string };
  /** Reads and maintains demo-206 and demo-208 only. */
  member: { id: Id<"users">; subject: string };
}

/**
 * Seeds the demo program, its aircraft, inspections and problem report, an
 * administrator and a member, and rows in every payload collection.
 *
 * @returns The two accounts, with their convex-test identity subjects.
 */
export async function seedStoredCollections(
  ctx: MutationCtx,
): Promise<SeededAccounts> {
  const demo = demoSnapshot();
  await ctx.db.insert("programs", demo.programs![0]);
  for (const a of demo.aircraft) await ctx.db.insert("aircraft", a);
  for (const i of demo.inspections) await ctx.db.insert("inspections", i);
  for (const d of demo.discrepancies) await ctx.db.insert("discrepancies", d);
  const group = await ctx.db.insert("groups", {
    programUuid: PROGRAM,
    name: "Maintenance",
    aircraftIds: [N206, N208],
    permissions: ["read", "maintenance"],
  });
  const accounts = {
    admin: await account(ctx, true, []),
    member: await account(ctx, false, [group]),
  };
  await seedPayloadRows(ctx, accounts.admin.id);
  return accounts;
}

async function account(
  ctx: MutationCtx,
  isAdmin: boolean,
  groupIds: Id<"groups">[],
) {
  const id = await ctx.db.insert("users", {
    name: isAdmin ? "Administrator" : "Mechanic",
    email: isAdmin ? "admin@example.test" : "mechanic@example.test",
    active: true,
    isAdmin,
    activeProgramUuid: PROGRAM,
    groupIds,
  });
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime: Date.now() + 86400000,
  });
  return { id, subject: `${id}|${session}` };
}

async function seedPayloadRows(ctx: MutationCtx, by: string) {
  const now = Date.now();
  // Builders such as emptyChecklist draw uuids in call order, and the golden
  // snapshots in convex/__golden__ hold them: keep this order.
  await seedManagement(ctx);
  await seedMaintenance(ctx, by, now);
  await seedPurchasing(ctx, by, now);
  await seedChecklist(ctx, by, now);
  await seedInspectionTemplate(ctx);
  await seedComponentTemplates(ctx);
  await seedCosts(ctx, now);
  await seedPlanning(ctx, now);
}

async function seedMaintenance(ctx: MutationCtx, by: string, now: number) {
  for (const [table, aircraftUuid] of [
    ["taskCards", N206],
    ["archivedTaskCards", N182],
  ] as const) {
    const card = taskCard(aircraftUuid, by, now);
    await ctx.db.insert(table, {
      uuid: card.uuid,
      aircraftUuid,
      payload: json(card),
    });
  }
  const order = workOrder(by, now);
  await ctx.db.insert("workOrders", {
    uuid: order.uuid,
    aircraftUuid: N206,
    payload: json(order),
  });
  const blank = blankAD(N206);
  const ad = adSchema.parse({
    ...blank,
    uuid: fixedUuid(6),
    version: 1,
    programUuid: PROGRAM,
    updatedAt: now,
    source: { ...blank.source, number: "2020-01-01", subject: "Demo AD" },
  });
  await ctx.db.insert("airworthiness", {
    uuid: ad.uuid,
    aircraftUuid: N206,
    programUuid: PROGRAM,
    payload: json(ad),
  });
}

async function seedInspectionTemplate(ctx: MutationCtx) {
  const template = inspectionTemplateSchema.parse({
    ...emptyTemplate(),
    version: 1,
    programUuid: PROGRAM,
    name: "100-hour",
    hours: 100,
    applicability: {
      kind: "aircraft",
      manufacturer: "Cessna",
      model: "206",
      partNumber: "",
    },
  });
  await ctx.db.insert("inspectionTemplates", {
    uuid: template.uuid,
    programUuid: PROGRAM,
    payload: json(template),
  });
}

async function seedChecklist(ctx: MutationCtx, by: string, now: number) {
  const checklist = checklistRecordSchema.parse({
    uuid: fixedUuid(7),
    version: 1,
    programUuid: PROGRAM,
    aircraftUuid: N206,
    sourceName: "Demo checklist",
    updatedAt: now,
    updatedBy: by,
    document: emptyChecklist(),
  });
  await ctx.db.insert("checklists", {
    uuid: checklist.uuid,
    programUuid: PROGRAM,
    aircraftUuid: N206,
    payload: json(checklist),
  });
}

async function seedPlanning(ctx: MutationCtx, now: number) {
  await ctx.db.insert("faaMonitors", {
    aircraftUuid: N206,
    payload: json(emptyMonitor(N206)),
  });
  const plan = flightPlan(now);
  await ctx.db.insert("flightPlans", {
    uuid: plan.uuid,
    aircraftUuid: N206,
    payload: json(plan),
  });
}

async function seedManagement(ctx: MutationCtx) {
  for (const raw of MANAGEMENT_RECORDS) {
    const record = recordSchema.parse(raw);
    await ctx.db.insert("management", {
      uuid: record.uuid,
      programUuid: PROGRAM,
      kind: record.kind,
      ...("aircraftUuid" in record
        ? { aircraftUuid: record.aircraftUuid }
        : {}),
      payload: json(raw),
    });
  }
}

function component(uuid: string, aircraftUuid: string) {
  return {
    uuid,
    version: 1,
    programUuid: PROGRAM,
    kind: "component",
    aircraftUuid,
    componentType: "Engine",
    partNumber: "IO-540",
    serial: "SN-" + uuid,
    manufacturer: "Lycoming",
    model: "IO-540",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: true,
    installedDate: "2025-01-01",
    installPosition: "MAIN",
    installedSeconds: 3600000,
    installedCycles: 400,
    timeSinceNew: 1800000,
    timeSinceOverhaul: 360000,
    timeSinceRepair: null,
    cyclesSinceNew: 400,
    serviceDaysBase: 0,
  };
}

const MANAGEMENT_RECORDS = [
  {
    uuid: "location-1",
    version: 1,
    programUuid: PROGRAM,
    kind: "location",
    name: "Main stores",
    address: "Demo airfield",
    contact: "stores@example.test",
  },
  {
    uuid: "stock-1",
    version: 1,
    programUuid: PROGRAM,
    kind: "stock",
    partNumber: "FILTER-1",
    alternates: "",
    description: "Oil filter",
    category: "part",
    condition: "new",
    locationUuid: "location-1",
    quantity: 8,
    minimum: 4,
    vendor: "Demo vendor",
    cost: 35,
  },
  // Untrimmed, and written before its defaulted fields were stored.
  {
    uuid: "vendor-1",
    version: 1,
    programUuid: PROGRAM,
    kind: "vendor",
    name: " Demo vendor ",
  },
  component("component-206", N206),
  component("component-182", N182),
];

function taskCard(aircraftUuid: string, by: string, now: number) {
  return taskCardSchema.parse({
    ...taskCardDefaults(aircraftUuid),
    uuid: fixedUuid(aircraftUuid === N206 ? 3 : 4),
    version: 1,
    cardNumber: "JC-1",
    title: "Oil change",
    description: "Change oil and filter",
    createdAt: now,
    updatedAt: now,
    createdBy: by,
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  });
}

function workOrder(by: string, now: number) {
  return workOrderSchema.parse({
    uuid: fixedUuid(5),
    version: 1,
    number: "WO-1",
    aircraftUuid: N206,
    dateOpened: "2026-01-01",
    supervisor: "Chief inspector",
    scope: "Annual inspection",
    priority: "routine",
    status: "open",
    completionDate: "",
    releaseOutcome: "",
    finalReview: "",
    recordedAt: now,
    createdBy: by,
    aircraft: {
      registration: "N206MA",
      make: "Cessna",
      model: "206",
      serial: "1",
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      meter: "hobbs",
      cycles: 0,
    },
    componentReadings: [],
    tasks: [],
  });
}

async function seedPurchasing(ctx: MutationCtx, by: string, now: number) {
  const po = purchaseOrder(by, now);
  await ctx.db.insert("purchaseOrders", {
    uuid: po.uuid,
    programUuid: PROGRAM,
    payload: json(po),
  });
  const request = partsRequest(by, now);
  await ctx.db.insert("partsRequests", {
    uuid: request.uuid,
    programUuid: PROGRAM,
    payload: json(request),
  });
}

const PO_LINE = {
  uuid: "po-line-1",
  stockUuid: "stock-1",
  locationUuid: "location-1",
  partNumber: "FILTER-1",
  description: "Oil filter",
  quantity: 4,
  unitCents: 3500,
  kind: "part",
};

function purchaseOrder(by: string, now: number) {
  const history = [
    {
      at: now,
      actorId: by,
      action: "created",
      reason: "",
      requestUuid: "request-1",
      detail: "",
    },
  ];
  return poSchema.parse({
    uuid: "po-1",
    version: 1,
    programUuid: PROGRAM,
    number: "PO-1",
    vendor: "Demo vendor",
    vendorContact: "sales@example.test",
    shipTo: "Demo airfield",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    phase: "draft",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    lines: [PO_LINE],
    shipments: [],
    receipts: [],
    history,
  });
}

// Its line was written before the line's defaulted fields were stored.
function partsRequest(by: string, now: number) {
  return {
    uuid: "request-1",
    version: 1,
    source: { kind: "stock" },
    mode: "parts",
    date: "2026-01-01",
    engineer: "Mechanic",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [
      {
        uuid: "request-line-1",
        partNumber: "FILTER-1",
        description: "Oil filter",
        quantity: 2,
      },
    ],
    programUuid: PROGRAM,
    aircraftUuid: N206,
    sourceLabel: "Stock",
    aircraftRegistration: "N206MA",
    aircraftSerial: "1",
    aircraftModel: "206",
    number: "PR-1",
    requesterId: by,
    createdAt: now,
    updatedAt: now,
    cancelled: false,
    reservations: [],
    issues: [],
    history: [],
  };
}

// Stored as written, with a field no schema knows, which readers keep.
async function seedComponentTemplates(ctx: MutationCtx) {
  const row = {
    componentType: "Engine",
    partNumber: "IO-540",
    model: "IO-540",
    manufacturer: "Lycoming",
  };
  const template = {
    uuid: fixedUuid(1),
    version: 1,
    programUuid: PROGRAM,
    name: "C206 engine",
    make: "Cessna",
    model: "206",
    rows: [row],
    legacyNote: "kept",
  };
  await ctx.db.insert("componentTemplates", {
    uuid: template.uuid,
    programUuid: PROGRAM,
    payload: json(template),
  });
  const setup = {
    uuid: "setup-1",
    programUuid: PROGRAM,
    aircraftUuid: N206,
    templateUuid: template.uuid,
    templateName: template.name,
    row,
    legacyNote: "kept",
  };
  await ctx.db.insert("componentSetups", {
    uuid: setup.uuid,
    programUuid: PROGRAM,
    aircraftUuid: N206,
    payload: json(setup),
  });
}

async function seedCosts(ctx: MutationCtx, now: number) {
  const rows = [
    {
      uuid: "cost-settings",
      version: 1,
      programUuid: PROGRAM,
      kind: "settings",
      laborRateCents: 9500,
    },
    {
      uuid: "budget-206",
      version: 1,
      programUuid: PROGRAM,
      kind: "budget",
      aircraftUuid: N206,
      year: new Date(now).getUTCFullYear(),
      amountCents: 2500000,
    },
  ];
  for (const raw of rows) {
    const record = costRecordSchema.parse(raw);
    const aircraftUuid = "aircraftUuid" in record ? record.aircraftUuid : "";
    await ctx.db.insert("costs", {
      uuid: record.uuid,
      programUuid: PROGRAM,
      aircraftUuid,
      payload: json(record),
    });
  }
}

function flightPlan(now: number) {
  return flightPlanSchema.parse({
    uuid: fixedUuid(2),
    version: 1,
    aircraftUuid: N206,
    registration: "N206MA",
    departureAt: "2026-01-02T12:00:00.000Z",
    origin: "KAAA",
    destination: "KBBB",
    alternate: "",
    durationMinutes: 60,
    cycles: 1,
    landings: 1,
    flightRules: "V",
    aircraftType: "C206",
    flightType: "G",
    speed: "N0120",
    level: "VFR",
    route: "DCT",
    pilotText: "Demo pilot",
    equipment: "",
    otherInformation: "",
    sourceName: "Demo plan",
    sourceHash: "0".repeat(64),
    status: "proposed",
    createdAt: now,
  });
}

const json = (value: unknown) => JSON.stringify(value);
// For schemas that require a uuid.
const fixedUuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
