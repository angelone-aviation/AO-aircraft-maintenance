/**
 * Responsibility: Pins the weekly summary query: Flight Program
 *   administrators only, the period checks and the caller's own day bounds,
 *   counts over the visible entries of the active program only, each once
 *   whichever index reaches it, records read by uuid to decide them,
 *   refused sign-ins counted only where they are read, and the flag set when
 *   the scan or lookup budget cuts the period short.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/auditHistory, convex/collections, src/data/demo,
 *   src/domain (auditSummary, purchaseOrders, partsRequests, costs,
 *   management).
 */
import { convexTest } from "convex-test";
import { afterEach, it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { summary } from "./auditHistory";
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
import { recordSchema } from "../src/domain/management";
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
  /** The exact time, in place of `daysAgo`. */
  at?: number;
  entityUuid?: string;
  actorId?: string;
  reason?: string;
  aircraftUuid?: string;
  programUuid?: string;
  after?: string;
};

afterEach(() => vi.useRealTimers());

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
    adminSubject: ids.admin,
    admin: t.withIdentity({ subject: ids.admin }),
    reader: t.withIdentity({ subject: ids.reader }),
    outsider: t.withIdentity({ subject: ids.outsider }),
  };
}

function insertRow(ctx: MutationCtx, row: Row) {
  const { daysAgo, at, ...fields } = row;
  // Program-tagged rows are visible when they concern a visible record or
  // aircraft; the program itself is one such record.
  return ctx.db.insert("audit", {
    uuid: crypto.randomUUID(),
    actorId: "alex",
    entityUuid: row.programUuid ?? PROGRAM,
    programUuid: PROGRAM,
    ...fields,
    at: at ?? NOW - daysAgo * DAY_MS,
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

it("says when the scan budget cut the period short, and counts the newest 4,000 rows it read", async () => {
  const rows: Row[] = [];
  // Rows past the 4,000-entry budget, all inside the period, created in
  // this order: the first 100 are the oldest.
  for (let i = 0; i < 4100; i++)
    rows.push({
      action: "flight.save",
      daysAgo: 0,
      actorId: i < 100 ? "earliest" : "alex",
    });
  const { admin } = await fixture(rows);
  const result = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
  });
  expect(result.truncated).toBe(true);
  expect(result.summary.actors.map((x) => [x.actorId, x.total])).toEqual([
    ["alex", 4000],
  ]);
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

it("stops once it has read 3 MiB, counting the newest rows, and reads at most 4 MiB when the rows are large", async () => {
  const notes = "Torque values recorded. ".repeat(LARGE_ROW_REPEATS);
  // 9 MB of rows inside the period, created in this order.
  const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({
    action: "taskCard.save",
    daysAgo: 0,
    actorId: i < 100 ? "earliest" : "alex",
    after: JSON.stringify({ notes }),
  }));
  const { t, adminSubject } = await fixture(rows);
  const args = { programUuid: PROGRAM, ...WEEK };
  const { result, bytes } = await t
    .withIdentity({ subject: adminSubject })
    .query(async (ctx) => {
      const handler = (summary as unknown as SummaryHandler)._handler;
      const result = await handler(ctx, args);
      const { bytesRead } = await ctx.meta.getTransactionMetrics();
      return { result, bytes: bytesRead.used };
    });
  expect(result.truncated).toBe(true);
  expect(result.summary.actors.map((x) => x.actorId)).toEqual(["alex"]);
  expect(bytes).toBeGreaterThanOrEqual(3 * MIB);
  expect(bytes).toBeLessThanOrEqual(4 * MIB);
}, 60_000);

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

// An aircraft's rows from before it joined the program carry the program
// that wrote them (one sorting before this program's uuid, one after), or
// none; a transfer lists rows no index of the program reaches; the program's
// rows stay on an aircraft that left (ADR-0005).
it("counts each row of the program once, whichever index reaches it, and none of another program's aircraft", async () => {
  const [ours, second, third] = demoSnapshot().aircraft;
  const { admin } = await fixtureOverTime([
    {
      action: "flight.dispatch_override",
      daysAgo: 1,
      aircraftUuid: ours.uuid,
      reason: "Positioning flight approved by the chief pilot",
    },
    {
      action: "taskCard.save",
      daysAgo: 2,
      aircraftUuid: ours.uuid,
      programUuid: "foreign",
      entityUuid: "card-1",
      actorId: "sam",
      reason: "Corrected the torque value",
    },
    {
      action: "inspection.completed",
      daysAgo: 3,
      aircraftUuid: second.uuid,
      programUuid: undefined,
      entityUuid: "inspection-1",
    },
    {
      action: "ad.complied",
      daysAgo: 3,
      aircraftUuid: third.uuid,
      programUuid: "another-program",
      entityUuid: "ad-1",
    },
    {
      action: "location.saved",
      daysAgo: 4,
      programUuid: "foreign",
      entityUuid: STORES_BAY,
      reason: "Renamed before the transfer",
      listedFor: PROGRAM,
    },
    {
      action: "cost.settings.laborRate",
      daysAgo: 5,
      aircraftUuid: THEIR_AIRCRAFT,
      entityUuid: "rate-1",
    },
    {
      action: "taskCard.save",
      daysAgo: 1,
      aircraftUuid: THEIR_AIRCRAFT,
      entityUuid: "their-card",
    },
    {
      action: "flight.created",
      daysAgo: 1,
      aircraftUuid: THEIR_AIRCRAFT,
      programUuid: "foreign",
      entityUuid: "their-flight",
    },
    { action: "flight.created", daysAgo: 8, aircraftUuid: ours.uuid },
  ]);
  const { summary, truncated } = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
  });
  expect(truncated).toBe(false);
  expect(summary.total).toBe(6);
  expect(summary.actors.map((x) => [x.actorId, x.total])).toEqual([
    ["alex", 5],
    ["sam", 1],
  ]);
  expect(summary.families).toEqual({
    flights: 1,
    maintenance: 1,
    ads: 1,
    workOrders: 1,
    parts: 1,
    access: 0,
    faa: 0,
    other: 1,
  });
  expect(summary.notable.map((n) => [n.kind, n.entityUuid])).toEqual([
    ["dispatch-override", PROGRAM],
    ["correction", "card-1"],
    ["correction", STORES_BAY],
  ]);
});

it("counts the rows created from the period's first midnight up to the midnight after its last day", async () => {
  const fromMs = Date.parse(WEEK.from + "T00:00:00Z");
  const toMs = Date.parse(TODAY + "T00:00:00Z") + DAY_MS;
  const row = (at: number, actorId: string): TimedRow => ({
    action: "flight.created",
    daysAgo: 0,
    at,
    actorId,
  });
  const { admin } = await fixtureOverTime([
    row(fromMs - MINUTE_MS, "before"),
    row(fromMs, "first"),
    row(toMs - MINUTE_MS, "last"),
    row(toMs, "after"),
  ]);
  const { summary } = await admin.query(api.auditHistory.summary, {
    programUuid: PROGRAM,
    ...WEEK,
    fromMs,
    toMs,
  });
  expect(summary.actors.map((x) => x.actorId)).toEqual(["first", "last"]);
});

const MINUTE_MS = 60_000;
const MIB = 1024 * 1024;
// About 30 KB of notes a row: a page of 25 such rows is 0.75 MB.
const LARGE_ROW_REPEATS = 1250;

// Convex keeps a registered function's handler on `_handler`; calling it
// inside a test query is the only way to read that query's reads after it.
type SummaryHandler = {
  _handler: (ctx: QueryCtx, args: object) => Promise<AuditSummaryResult>;
};
const STORES_BAY = "stores-bay";
const THEIR_AIRCRAFT = "foreign-aircraft";

/** A row created at its own `at`; `listedFor` lists it as a transfer does. */
type TimedRow = Row & { listedFor?: string };

// The fixture, with the program's labor rate, a location and another
// program's aircraft, and each row created in a transaction of its own at its
// `at`, as the app writes them, so the scan by creation time meets it there.
async function fixtureOverTime(rows: TimedRow[]) {
  const timeOf = (r: Row) => r.at ?? NOW - r.daysAgo * DAY_MS;
  // convex-test never dates a row before an earlier one, so the rest comes
  // first.
  vi.useFakeTimers({ now: NOW - 30 * DAY_MS, toFake: ["Date"] });
  const seeded = await fixture([]);
  await seeded.t.run(insertProgramRecords);
  const oldestFirst = [...rows].sort((a, b) => timeOf(a) - timeOf(b));
  for (const { listedFor, ...row } of oldestFirst) {
    vi.setSystemTime(timeOf(row));
    await seeded.t.run(async (ctx) => {
      const auditId = await insertRow(ctx, row);
      if (!listedFor) return;
      const listed = await ctx.db.get(auditId);
      await ctx.db.insert("transferredAudit", {
        programUuid: listedFor,
        auditId,
        auditCreationTime: listed!._creationTime,
      });
    });
  }
  vi.useRealTimers();
  return seeded;
}

async function insertProgramRecords(ctx: MutationCtx) {
  await insertRecord(ctx, laborRate("rate-1", PROGRAM));
  await ctx.db.insert(
    "management",
    encode(
      "management",
      recordSchema.parse({
        uuid: STORES_BAY,
        version: 1,
        programUuid: PROGRAM,
        kind: "location",
        name: "Stores bay",
        address: "Hangar 4",
        contact: "stores@example.test",
      }),
    ),
  );
  await ctx.db.insert("aircraft", {
    ...demoSnapshot().aircraft[0],
    uuid: THEIR_AIRCRAFT,
    registration: "N900FX",
    programUuid: "foreign",
  });
}

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
