/**
 * Responsibility: Pins the weekly summary query: Flight Program
 *   administrators only, the period checks and the caller's own day bounds,
 *   counts over the visible entries of the active program only, records
 *   read by uuid to decide them, refused sign-ins counted only where they
 *   are read, and the flag set when the scan or lookup budget cuts the
 *   period short.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/auditHistory, convex/collections, src/data/demo,
 *   src/domain (auditSummary, purchaseOrders, partsRequests, costs).
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { demoSnapshot } from "../src/data/demo";
import type { AuditSummaryResult } from "../src/domain/auditSummary";
import { encode } from "./collections";
import { poSchema, type PurchaseOrder } from "../src/domain/purchaseOrders";
import {
  partsRequestSchema,
  requestDraftSchema,
  type PartsRequest,
} from "../src/domain/partsRequests";
import { costRecordSchema, type CostRecord } from "../src/domain/costs";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
const PROGRAM = "demo-program";
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const WEEK = {
  from: new Date(NOW - 6 * DAY_MS).toISOString().slice(0, 10),
  to: TODAY,
};

type Row = {
  action: string;
  daysAgo: number;
  entityUuid?: string;
  actorId?: string;
  reason?: string;
  aircraftUuid?: string;
  programUuid?: string;
  after?: string;
};

async function fixture(rows: Row[]) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const s = demoSnapshot();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("programs", {
      ...s.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    for (const row of rows) await insertRow(ctx, row);
    const user = async (programUuid: string, programAdmin: boolean) => {
      const group = await ctx.db.insert("groups", {
        programUuid,
        programAdmin,
        name: programAdmin ? "Managers" : "Observers",
        aircraftIds: [],
        permissions: ["read"],
      });
      const id = await ctx.db.insert("users", {
        name: programAdmin ? "Alex" : "Sam",
        active: true,
        isAdmin: false,
        activeProgramUuid: programUuid,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: NOW + DAY_MS,
      });
      return `${id}|${session}`;
    };
    return {
      admin: await user(PROGRAM, true),
      reader: await user(PROGRAM, false),
      outsider: await user("foreign", true),
    };
  });
  return {
    t,
    admin: t.withIdentity({ subject: ids.admin }),
    reader: t.withIdentity({ subject: ids.reader }),
    outsider: t.withIdentity({ subject: ids.outsider }),
  };
}

function insertRow(ctx: MutationCtx, row: Row) {
  const { daysAgo, ...fields } = row;
  // Program-tagged rows are visible when they concern a visible record or
  // aircraft; the program itself is one such record.
  return ctx.db.insert("audit", {
    uuid: crypto.randomUUID(),
    actorId: "alex",
    entityUuid: row.programUuid ?? PROGRAM,
    programUuid: PROGRAM,
    ...fields,
    at: NOW - daysAgo * DAY_MS,
  });
}

it("summarizes the week for a program administrator: families, actors, notable events and refused sign-ins", async () => {
  const [a] = demoSnapshot().aircraft;
  const { admin } = await fixture([
    { action: "flight.created", daysAgo: 0, aircraftUuid: a.uuid },
    { action: "flight.created", daysAgo: 1, actorId: "sam" },
    {
      action: "flight.dispatch_override",
      daysAgo: 2,
      actorId: "sam",
      reason: "Positioning flight approved by the chief pilot",
    },
    { action: "inspection.completed", daysAgo: 3 },
    { action: "flight.created", daysAgo: 9 },
    { action: "flight.created", daysAgo: 0, programUuid: "foreign" },
  ]);
  const result: AuditSummaryResult = await admin.query(
    api.auditHistory.summary,
    { programUuid: PROGRAM, ...WEEK },
  );
  expect(result.truncated).toBe(false);
  // Refused sign-ins carry no program, so a program's summary has none.
  expect(result.accountWide).toBe(false);
  expect(result.summary.total).toBe(4);
  expect(result.summary.refusedSignIns).toBe(0);
  expect(result.summary.actors.map((x) => [x.actorId, x.total])).toEqual([
    ["alex", 2],
    ["sam", 2],
  ]);
  expect(result.summary.families).toMatchObject({
    flights: 3,
    maintenance: 1,
  });
  expect(result.summary.notable.map((n) => n.kind)).toEqual([
    "dispatch-override",
  ]);
});

it("refuses readers, outsiders and bad periods", async () => {
  const { admin, reader, outsider } = await fixture([
    { action: "flight.created", daysAgo: 0 },
  ]);
  await expect(
    reader.query(api.auditHistory.summary, { programUuid: PROGRAM, ...WEEK }),
  ).rejects.toThrow("Flight Program administrator required.");
  await expect(
    outsider.query(api.auditHistory.summary, {
      programUuid: PROGRAM,
      ...WEEK,
    }),
  ).rejects.toThrow("Flight Program changed.");
  const foreign = await outsider.query(api.auditHistory.summary, {
    programUuid: "foreign",
    ...WEEK,
  });
  expect(foreign.summary.total).toBe(0);
  await expect(
    admin.query(api.auditHistory.summary, {
      programUuid: PROGRAM,
      from: TODAY,
      to: WEEK.from,
    }),
  ).rejects.toThrow("Choose a start date on or before the end date.");
  await expect(
    admin.query(api.auditHistory.summary, {
      programUuid: PROGRAM,
      from: "last week",
      to: TODAY,
    }),
  ).rejects.toThrow("Choose a start and end date.");
});

it("says when the scan budget cut the period short", async () => {
  const rows: Row[] = [];
  // Rows past the 4,000-entry budget, all inside the period.
  for (let i = 0; i < 4100; i++)
    rows.push({ action: "flight.save", daysAgo: 0 });
  const { admin } = await fixture(rows);
  const result = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
  });
  expect(result.truncated).toBe(true);
  expect(result.summary.total).toBeGreaterThan(0);
  expect(result.summary.total).toBeLessThan(4100);
}, 60_000);

// A New York reviewer's day: midnight there is 05:00 UTC in November.
const NEW_YORK_OFFSET_MS = 5 * 3_600_000;
const newYorkDay = (date: string) => ({
  from: date,
  to: date,
  fromMs: Date.parse(date + "T00:00:00Z") + NEW_YORK_OFFSET_MS,
  toMs: Date.parse(date + "T00:00:00Z") + DAY_MS + NEW_YORK_OFFSET_MS,
});

it("counts a change made this evening west of UTC in that reviewer's today", async () => {
  // 20:00 in New York is 01:00 UTC on the next UTC date.
  const evening = Date.parse(TODAY + "T00:00:00Z") + DAY_MS + 3_600_000;
  const daysAgo = (NOW - evening) / DAY_MS;
  const { admin } = await fixture([{ action: "flight.created", daysAgo }]);
  const asked = { programUuid: PROGRAM, ...newYorkDay(TODAY) };
  const local = await admin.query(api.auditHistory.summary, asked);
  expect(local.summary.total).toBe(1);
  // Without the reviewer's bounds the records time zone's days apply, US
  // Eastern by default, as they do for the server's alerts.
  const records = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    from: TODAY,
    to: TODAY,
  });
  expect(records.summary.total).toBe(1);
});

it("refuses day bounds that are not the dates' midnights in some time zone", async () => {
  const { admin } = await fixture([]);
  const day = newYorkDay(TODAY);
  for (const bounds of [
    { fromMs: day.fromMs },
    { toMs: day.toMs },
    { fromMs: day.fromMs - 2 * DAY_MS, toMs: day.toMs },
    { fromMs: day.fromMs, toMs: day.toMs + DAY_MS },
  ])
    await expect(
      admin.query(api.auditHistory.summary, {
        programUuid: PROGRAM,
        from: TODAY,
        to: TODAY,
        ...bounds,
      }),
    ).rejects.toThrow("Choose a start and end date.");
});

it("counts refused sign-ins for a system administrator in Unassigned records only", async () => {
  const t = convexTest(schema, modules);
  const subject = (activeProgramUuid: string) =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Root",
        active: true,
        isAdmin: true,
        activeProgramUuid,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: NOW + DAY_MS,
      });
      return `${userId}|${session}`;
    });
  await t.run((ctx) => ctx.db.insert("programs", demoSnapshot().programs![0]));
  await t.mutation(internal.identities.recordRefusal, {
    provider: "google",
    providerAccountId: "1234567890",
    email: "stranger@example.test",
    reason: "no_account",
  });
  const unassigned = t.withIdentity({ subject: await subject("") });
  const result = await unassigned.query(api.auditHistory.summary, WEEK);
  expect(result.accountWide).toBe(true);
  expect(result.summary.refusedSignIns).toBe(1);
  expect(JSON.stringify(result)).not.toContain("stranger@");
  const inProgram = t.withIdentity({ subject: await subject(PROGRAM) });
  const programWide = await inProgram.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
  });
  expect(programWide.accountWide).toBe(false);
  expect(programWide.summary.refusedSignIns).toBe(0);
});

// Rows about a purchase order, a stock request or the labor rate carry no
// aircraft: the summary reads the record each names by its uuid (ADR-0013).
it("counts rows about the program's purchase orders, requests and cost records, each read by its uuid, and not another program's", async () => {
  const records = [
    purchaseOrder("po-1", PROGRAM),
    stockRequest("request-1", PROGRAM),
    laborRate("rate-1", PROGRAM),
    purchaseOrder("po-foreign", "foreign"),
  ];
  const rows = ["po.save", "partsRequest.save", "cost.settings.laborRate"]
    .map((action, n) => ({ action, daysAgo: 0, entityUuid: records[n].uuid }))
    .concat([{ action: "po.save", daysAgo: 0, entityUuid: "po-foreign" }]);
  const { admin, t } = await fixture(rows);
  await t.run(async (ctx) => {
    for (const record of records) await insertRecord(ctx, record);
  });
  const result = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
  });
  expect(result.summary.total).toBe(3);
  expect(result.truncated).toBe(false);
});

it("says the period was cut short when its rows name more records than it looks up", async () => {
  // Each row names a record of its own that the program does not hold.
  const named = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      action: "po.save",
      daysAgo: 0,
      entityUuid: `missing-${n}`,
    }));
  const within = await fixture(named(100));
  const past = await fixture(named(101));
  const ask = { programUuid: PROGRAM, ...WEEK };
  expect(
    (await within.admin.query(api.auditHistory.summary, ask)).truncated,
  ).toBe(false);
  expect(
    (await past.admin.query(api.auditHistory.summary, ask)).truncated,
  ).toBe(true);
});

type ProgramRecord =
  | { table: "purchaseOrders"; uuid: string; record: PurchaseOrder }
  | { table: "partsRequests"; uuid: string; record: PartsRequest }
  | { table: "costs"; uuid: string; record: CostRecord };

// One branch per table: insert's types need the table and its row to agree.
function insertRecord(ctx: MutationCtx, { table, record }: ProgramRecord) {
  if (table === "purchaseOrders")
    return ctx.db.insert(table, encode(table, record));
  if (table === "partsRequests")
    return ctx.db.insert(table, encode(table, record));
  return ctx.db.insert(table, encode(table, record));
}

function purchaseOrder(uuid: string, programUuid: string): ProgramRecord {
  const record = poSchema.parse({
    uuid,
    version: 1,
    programUuid,
    number: `PO-${uuid}`,
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    phase: "draft",
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        uuid: "po-line",
        locationUuid: "store",
        partNumber: "F",
        description: "Filter",
        quantity: 1,
        unitCents: 100,
        kind: "part",
      },
    ],
    shipments: [],
    receipts: [],
    history: [],
  });
  return { table: "purchaseOrders", uuid, record };
}

function stockRequest(uuid: string, programUuid: string): ProgramRecord {
  const record = partsRequestSchema.parse({
    ...requestDraftSchema.parse({
      uuid,
      version: 1,
      source: { kind: "stock" },
      mode: "parts",
      date: TODAY,
      engineer: "Mechanic",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [{ uuid: "line", partNumber: "F", description: "F", quantity: 1 }],
    }),
    programUuid,
    aircraftUuid: "",
    sourceLabel: "Inventory stock request",
    aircraftRegistration: "",
    aircraftSerial: "",
    aircraftModel: "",
    number: `PR-${uuid}`,
    requesterId: "alex",
    createdAt: NOW,
    updatedAt: NOW,
    cancelled: false,
    reservations: [],
    issues: [],
    history: [],
  });
  return { table: "partsRequests", uuid, record };
}

function laborRate(uuid: string, programUuid: string): ProgramRecord {
  const record = costRecordSchema.parse({
    uuid,
    version: 1,
    programUuid,
    kind: "settings",
    laborRateCents: 9500,
  });
  return { table: "costs", uuid, record };
}
