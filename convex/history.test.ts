/**
 * Responsibility: Pins the paged history queries: who may page what, cursors
 *   across ties and page boundaries, and that each page equals historyPage
 *   on the caller's own scoped snapshot, purchasing and flight plans
 *   included.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (history, schema, collections, memberships,
 *   purchasingKeys, _generated), tests/fixtures (derivedColumns,
 *   legacySnapshot, historyPages, purchasingEdges), src/data/demo.ts,
 *   src/domain (retention, historyReads, programs, record schemas).
 *
 * Within a tie the rows are inserted out of uuid order, so a server that
 * left ties in creation order would fail.
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { api } from "./_generated/api";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { encode, flightColumns } from "./collections";
import { syncMemberships } from "./memberships";
import { syncPurchasingKeys } from "./purchasingKeys";
import { edgeLabel, edgeRecords } from "../tests/fixtures/purchasingEdges";
import { forgetDerivedColumns } from "../tests/fixtures/derivedColumns";
import { legacySnapshot } from "../tests/fixtures/legacySnapshot";
import {
  expectOraclePages,
  queryHistoryPage,
  type HistoryClient,
  type PageArgs,
} from "../tests/fixtures/historyPages";
import { demoSnapshot } from "../src/data/demo";
import {
  historyCursor,
  historyPage,
  type HistoryKind,
  type HistoryPage,
} from "../src/domain/retention";
import {
  FLIGHT_RANGE_INVALID,
  MAX_RECORD_LOOKUPS,
  RECORD_LOOKUP_TOO_LARGE,
  flightRange,
  lookupRecords,
  workOrderHistory,
  type RecordLookup,
} from "../src/domain/historyReads";
import type { Discrepancy, Flight, Snapshot } from "../src/domain/model";
import { scopedSnapshot } from "../src/domain/programs";
import { workOrderSchema, type WorkOrder } from "../src/domain/workOrders";
import { taskCardDefaults, taskCardSchema } from "../src/domain/taskCards";
import { costRecordSchema } from "../src/domain/costs";
import { partsRequestSchema } from "../src/domain/partsRequests";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 15, 30);
const OLD = Date.UTC(2024, 2, 1, 12);
const RECENT = NOW - 10 * DAY;
const P = "program-p";
const Q = "program-q";
const [P1, P2, P3] = ["p-aircraft-1", "p-aircraft-2", "p-aircraft-3"];
const Q1 = "q-aircraft-1";
const KINDS = [
  "flights",
  "discrepancies",
  "workOrders",
  "partsRequests",
  "purchaseOrders",
  "flightPlans",
] as const;
// The lists an aircraft narrows; purchase orders belong to none.
const AIRCRAFT_KINDS = KINDS.filter((kind) => kind !== "purchaseOrders");
const SIZES = [1, 2, 3, 7];
const MAX_PAGES = 200;
const NOT_FOUND = "History not found.";
const NO_SESSION = "An active account and session are required.";
const STALE = "Flight Program changed. Reopen the form in the correct program.";

type Convex = TestConvex<typeof schema>;
type Client = HistoryClient;
type Outcome = { refused: string } | { returned: unknown };
type Role = "admin" | "pilot" | "mechanic" | "owner" | "board" | "outsider";
type GroupFields = Partial<WithoutSystemFields<Doc<"groups">>>;
type FlightRow = WithoutSystemFields<Doc<"flights">>;
/** What the world holds for the cases to aim at. */
interface World {
  subjects: Record<Role, string>;
  /** An older work order on P2, with evidence, a file and a request. */
  filedOrder: string;
  /** A flight's start on P1 the range cases bracket. */
  oldStart: number;
}

let t: Convex;
let world: World;

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW });
  t = convexTest(schema, modules);
  world = await t.run(seedWorld);
});

afterAll(() => vi.useRealTimers());

describe("who may page history", () => {
  it("gives a program administrator every aircraft of the program, none of another's", async () => {
    const pages = await allKinds(as("admin"), {});
    expect(aircraftOf(pages)).toEqual([P1, P2, P3]);
  });

  it("gives a pilot only the aircraft their group covers", async () => {
    const pages = await allKinds(as("pilot"), {});
    expect(aircraftOf(pages)).toEqual([P1]);
  });

  it("refuses an aircraft the caller may not read exactly as one that does not exist", async () => {
    for (const kind of AIRCRAFT_KINDS) {
      const theirs = await settle(
        page(as("pilot"), kind, { aircraftUuid: P2 }),
      );
      expect(theirs).toEqual({ refused: NOT_FOUND });
      const none = page(as("pilot"), kind, { aircraftUuid: "no-aircraft" });
      expect(await settle(none)).toEqual(theirs);
    }
    const range = { aircraftUuid: P2, from: OLD - DAY, to: OLD + DAY };
    expect(await settle(flightsInRange(as("pilot"), range))).toEqual({
      refused: NOT_FOUND,
    });
    expect(await settle(order(as("pilot"), world.filedOrder))).toEqual({
      refused: NOT_FOUND,
    });
    expect(await settle(order(as("pilot"), "no-such-order"))).toEqual({
      refused: NOT_FOUND,
    });
  });

  it("redacts a mechanic's costs as their workspace does", async () => {
    const orders = await page(as("mechanic"), "workOrders", { numItems: 100 });
    const labor = orders.records.costs.flatMap((c) =>
      c.kind === "workOrder" ? c.labor : [],
    );
    expect(labor.length).toBeGreaterThan(0);
    expect(JSON.stringify(orders.records.costs)).not.toContain("rateCents");
    expect(
      orders.records.costs.flatMap((c) =>
        c.kind === "workOrder" ? c.other : [],
      ),
    ).toEqual([]);
  });

  it("leaves out a cost record another program paid for (decision D14)", async () => {
    const theirs = uuidOf(9_003);
    await t.run(async (ctx) => {
      const [row] = await ctx.db
        .query("workOrders")
        .withIndex("uuid", (q) => q.eq("uuid", world.filedOrder))
        .collect();
      const w = workOrderSchema.parse(JSON.parse(row.payload));
      const paid = { ...cost(w, theirs, "q-admin", RECENT), programUuid: Q };
      await ctx.db.insert("costs", encode("costs", paid));
    });
    const orders = await allWorkOrders(as("admin"));
    expect(orders.records.workOrders.map((w) => w.uuid)).toContain(
      world.filedOrder,
    );
    const history = await order(as("admin"), world.filedOrder);
    for (const costs of [orders.records.costs, history.costs])
      expect(costs.map((c) => c.uuid)).not.toContain(theirs);
    expect(history.costs).toHaveLength(1);
  });

  it.each([
    ["owner", "Aircraft owner access is read-only."],
    ["board", "Board access is read-only."],
  ] as const)("refuses an aircraft %s every query", async (role, message) => {
    for (const outcome of await everyQuery(as(role)))
      expect(outcome).toEqual({ refused: message });
  });

  it("refuses a member of another program that names this one, and finds none of its records", async () => {
    for (const outcome of await everyQuery(as("outsider")))
      expect(outcome).toEqual({ refused: STALE });
    const own = await allKinds(as("outsider"), { programUuid: Q });
    expect(aircraftOf(own)).toEqual([Q1]);
    const aimed = page(as("outsider"), "flights", {
      programUuid: Q,
      aircraftUuid: P1,
    });
    expect(await settle(aimed)).toEqual({ refused: NOT_FOUND });
    const theirOrder = order(as("outsider"), world.filedOrder, Q);
    expect(await settle(theirOrder)).toEqual({ refused: NOT_FOUND });
  });

  it("refuses a stale program before reading anything", async () => {
    for (const outcome of await everyQuery(as("pilot"), Q))
      expect(outcome).toEqual({ refused: STALE });
  });

  it("asks an anonymous caller for a session before anything else", async () => {
    for (const outcome of await everyQuery(t))
      expect(outcome).toEqual({ refused: NO_SESSION });
  });
});

describe("pages equal historyPage on the caller's scoped snapshot", () => {
  it.each(["admin", "pilot", "mechanic"] as const)(
    "for a %s, page by page, at every size",
    async (role) => {
      const s = await snapshotOf(role);
      for (const kind of KINDS)
        for (const numItems of SIZES)
          await expectOraclePages(
            as(role),
            s,
            { programUuid: P, kind, cursor: null, numItems },
            NOW,
          );
    },
  );

  it("narrows requests to a record's list and orders to a vendor as the oracle does", async () => {
    const s = await snapshotOf("admin");
    const repair = (s.partsRequests ?? []).find(
      (r) => edgeLabel(r.number) === "REPAIR" && r.aircraftUuid === P2,
    )!;
    const first = { programUuid: P, cursor: null, numItems: 2 };
    const listed = await expectOraclePages(
      as("admin"),
      s,
      { ...first, kind: "partsRequests", source: repair.source },
      NOW,
    );
    expect(listed.partsRequests.map((r) => r.uuid)).toEqual([repair.uuid]);
    for (const vendor of ["example aviation supply", "Nobody"])
      await expectOraclePages(
        as("admin"),
        s,
        { ...first, kind: "purchaseOrders", vendor },
        NOW,
      );
  });

  it("brings each older request's purchases and each older plan's flights", async () => {
    const requests = await page(as("mechanic"), "partsRequests", {
      numItems: 100,
    });
    const repairs = requests.records.partsRequests.filter(
      (r) => edgeLabel(r.number) === "REPAIR",
    );
    expect(repairs.map((r) => r.aircraftUuid).sort()).toEqual([P1, P2, P3]);
    const received = new Map(
      requests.records.partsRequestPurchases.map((a) => [
        a.requestUuid,
        a.received,
      ]),
    );
    for (const r of repairs) expect(received.get(r.uuid)).toBe(1);
    expect(requests.records.purchaseOrders).toEqual([]);
    const plans = await page(as("pilot"), "flightPlans", { numItems: 100 });
    expect(plans.records.flightPlans.map((p) => p.aircraftUuid)).toEqual([P1]);
  });

  it("filters flights by aircraft and outcome as the oracle does", async () => {
    const s = await snapshotOf("admin");
    for (const status of ["accepted", "rejected", "review"] as const)
      await expectOraclePages(
        as("admin"),
        s,
        {
          programUuid: P,
          kind: "flights",
          aircraftUuid: P2,
          status,
          cursor: null,
          numItems: 2,
        },
        NOW,
      );
  });

  it("pages every row the window leaves out once, after what it keeps", async () => {
    const s = await snapshotOf("admin");
    const flights = await allPages(as("admin"), "flights", 3);
    expect(flights.map((f) => f.uuid)).toEqual(
      oraclePages(s, "flights").map((f) => f.uuid),
    );
    expect(new Set(flights.map((f) => f.uuid)).size).toBe(flights.length);
    expect(flights.length).toBeGreaterThan(0);
  });

  it("keeps its place when newer older rows arrive between pages", async () => {
    const request = { kind: "flights", cursor: null, numItems: 2 } as const;
    const first = await page(as("admin"), "flights", request);
    await t.run((ctx) =>
      insertFlight(ctx, {
        aircraftUuid: P1,
        start: OLD + DAY,
        uuid: uuidOf(9_001),
      }),
    );
    const next = { ...request, cursor: first.continueCursor };
    const s = await snapshotOf("admin");
    expect(await page(as("admin"), "flights", next)).toEqual(
      historyPage(s, next, NOW),
    );
  });

  it("refuses a cursor of another list's key type", async () => {
    const cursor = historyCursor(["2024-01-01", uuidOf(1)]);
    expect(await settle(page(as("admin"), "flights", { cursor }))).toEqual({
      refused: "Invalid history cursor.",
    });
  });
});

describe("the members a page names", () => {
  it("names a former member who flew the page's flights", async () => {
    const flights = await page(as("pilot"), "flights", { numItems: 100 });
    expect(flights.members.map((m) => m.name)).toContain("Former pilot");
  });

  // Characterizes current behaviour: the full-history snapshot also names a
  // former member who flew any flight, but a page sees only its own rows.
  it("names a former member who resolved a report only if the page's rows show them flying", async () => {
    const formerId = await t.run(async (ctx) => {
      const former = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", "former@example.test"))
        .unique();
      await ctx.db.insert("discrepancies", {
        uuid: uuidOf(9_002),
        aircraftUuid: P3,
        description: "Pitot heat inoperative.",
        authorId: former!._id,
        createdAt: OLD - 10 * DAY,
        status: "resolved",
        resolution: "Replaced element.",
        resolvedBy: former!._id,
        resolvedAt: OLD - 9 * DAY,
      });
      return former!._id;
    });
    const request = {
      kind: "discrepancies",
      aircraftUuid: P3,
      cursor: null,
      numItems: 100,
    } as const;
    const served = await page(as("admin"), "discrepancies", request);
    const oracle = historyPage(await snapshotOf("admin"), request, NOW);
    expect(served.records).toEqual(oracle.records);
    expect(oracle.members.map((m) => m.id)).toContain(formerId);
    expect(served.members).toEqual(
      oracle.members.filter((m) => m.id !== formerId),
    );
  });
});

describe("history.workOrder", () => {
  it.each(["admin", "mechanic"] as const)(
    "holds what workOrderHistory finds on a %s's snapshot",
    async (role) => {
      const s = await snapshotOf(role);
      const history = await order(as(role), world.filedOrder);
      expect(history).toEqual(workOrderHistory(s, world.filedOrder));
      expect(history.taskEvidence).toHaveLength(1);
      expect(history.workOrderAttachments).toHaveLength(1);
      expect(history.partsRequests).toHaveLength(1);
      expect(history.archivedTaskCards).toHaveLength(1);
    },
  );

  it.each(["admin", "mechanic"] as const)(
    "counts a request on one of its job cards, with its purchases, for a %s",
    async (role) => {
      const s = await snapshotOf(role);
      const open = (s.workOrders ?? []).find(
        (w) => w.aircraftUuid === P2 && w.status === "in-progress",
      )!;
      const history = await order(as(role), open.uuid);
      expect(history).toEqual(workOrderHistory(s, open.uuid));
      expect(history.partsRequests.map((r) => edgeLabel(r.number))).toEqual([
        "TASK",
        "CARD",
      ]);
    },
  );
});

describe("history.flightsInRange", () => {
  it("holds what flightRange finds on the caller's snapshot", async () => {
    const s = await snapshotOf("pilot");
    const range = {
      aircraftUuid: P1,
      from: world.oldStart - DAY,
      to: world.oldStart,
    };
    const found = await flightsInRange(as("pilot"), range);
    expect(found).toEqual(flightRange(s, range));
    expect(found.flights.length).toBeGreaterThan(0);
    expect(found.members.map((m) => m.name)).toContain("Former pilot");
  });

  it("refuses a span whose end is not after its start", async () => {
    const range = { aircraftUuid: P1, from: OLD, to: OLD };
    expect(await settle(flightsInRange(as("pilot"), range))).toEqual({
      refused: FLIGHT_RANGE_INVALID,
    });
  });
});

describe("history.records", () => {
  it.each(["admin", "pilot", "mechanic"] as const)(
    "holds what lookupRecords finds on a %s's snapshot",
    async (role) => {
      const plan = uuidOf(9_100);
      await t.run(async (ctx) => {
        if (
          await ctx.db
            .query("flights")
            .withIndex("plan", (q) => q.eq("flightPlanUuid", plan))
            .first()
        )
          return;
        for (const aircraftUuid of [P1, P2])
          await insertFlight(ctx, {
            aircraftUuid,
            start: OLD + (aircraftUuid === P1 ? 1 : 2),
            flightPlanUuid: plan,
          });
      });
      const named = await t.run(async (ctx) => ({
        reports: (await ctx.db.query("discrepancies").collect()).map(
          (d) => d.uuid,
        ),
        cards: [
          ...(await ctx.db.query("taskCards").collect()),
          ...(await ctx.db.query("archivedTaskCards").collect()),
        ].map((c) => c.uuid),
      }));
      const purchasing = await t.run(async (ctx) => ({
        requests: (await ctx.db.query("partsRequests").collect()).map(
          (r) => r.uuid,
        ),
        orders: (await ctx.db.query("purchaseOrders").collect()).map(
          (p) => p.uuid,
        ),
      }));
      const lookup = {
        discrepancyUuids: [...named.reports.slice(0, 20), "no-such-report"],
        taskCardUuids: named.cards.slice(0, 30),
        flightPlanUuids: [plan],
        partsRequestUuids: purchasing.requests.slice(0, 30),
        purchaseOrderUuids: purchasing.orders.slice(0, 15),
      };
      const found = await lookupFrom(as(role), lookup);
      const oracle = lookupRecords(await snapshotOf(role), lookup);
      expect({ ...found, members: [] }).toEqual({ ...oracle, members: [] });
      // Characterizes current behaviour: as on a page, a former member is
      // named only when the lookup's own flights show them flying.
      const flew = new Set(
        found.flights.flatMap((f) => [f.pilotId, f.copilotId]),
      );
      expect(found.members).toEqual(
        oracle.members.filter((m) => m.active || flew.has(m.id)),
      );
      expect(found.flights.length).toBeGreaterThan(0);
      expect(found.discrepancies.length).toBeGreaterThan(0);
      expect(found.partsRequests.length).toBeGreaterThan(0);
      expect(found.partsRequestPurchases.length).toBeGreaterThan(0);
      expect(found.purchaseOrders.length > 0).toBe(role === "admin");
      const aircraft = new Set(
        [...found.discrepancies, ...found.flights].map((r) => r.aircraftUuid),
      );
      if (role === "pilot") expect([...aircraft]).toEqual([P1]);
    },
  );

  it(`refuses more than ${MAX_RECORD_LOOKUPS} uuids`, async () => {
    const many = Array.from({ length: MAX_RECORD_LOOKUPS + 1 }, (_, i) =>
      uuidOf(i),
    );
    const lookup = {
      discrepancyUuids: many,
      taskCardUuids: [],
      flightPlanUuids: [],
    };
    expect(await settle(lookupFrom(as("admin"), lookup))).toEqual({
      refused: RECORD_LOOKUP_TOO_LARGE,
    });
  });
});

describe("rows stored before the derived columns", () => {
  it("refuses to page a list until the backfill fills its columns", async () => {
    const local = convexTest(schema, modules);
    const seeded = await local.run(seedWorld);
    const client = local.withIdentity({ subject: seeded.subjects.admin });
    const tables = [
      "flights",
      "workOrders",
      "partsRequests",
      "purchaseOrders",
      "flightPlans",
    ] as const;
    for (const table of tables) {
      const first = await local.run(
        async (ctx) => (await ctx.db.query(table).collect())[0],
      );
      await forgetDerivedColumns(local, table, [first!.uuid]);
      expect(await settle(page(client, table, {})), table).toEqual({
        refused: `History columns are missing on ${table}; run migrations:backfillHistoryColumns.`,
      });
    }
  });
});

function as(role: Role): Client {
  return t.withIdentity({ subject: world.subjects[role] });
}

function page(
  client: Client,
  kind: HistoryKind,
  args: PageArgs = {},
): Promise<HistoryPage> {
  return queryHistoryPage(client, kind, { programUuid: P, ...args });
}

function order(client: Client, uuid: string, programUuid = P) {
  return client.query(api.history.workOrder, { programUuid, uuid });
}

function flightsInRange(
  client: Client,
  range: { aircraftUuid: string; from: number; to: number },
  programUuid = P,
) {
  return client.query(api.history.flightsInRange, { programUuid, ...range });
}

function lookupFrom(client: Client, lookup: RecordLookup, programUuid = P) {
  return client.query(api.history.records, { programUuid, ...lookup });
}

// Every public history query, aimed at program P's records.
function everyQuery(client: Client, programUuid = P): Promise<Outcome[]> {
  const range = { aircraftUuid: P1, from: OLD - DAY, to: OLD + DAY };
  return Promise.all([
    ...KINDS.map((kind) => settle(page(client, kind, { programUuid }))),
    settle(order(client, world.filedOrder, programUuid)),
    settle(flightsInRange(client, range, programUuid)),
    settle(
      lookupFrom(
        client,
        { discrepancyUuids: [], taskCardUuids: [], flightPlanUuids: [] },
        programUuid,
      ),
    ),
  ]);
}

async function allKinds(
  client: Client,
  args: { programUuid?: string },
): Promise<HistoryPage[]> {
  return Promise.all(
    AIRCRAFT_KINDS.map((kind) =>
      page(client, kind, { ...args, numItems: 100 }),
    ),
  );
}

async function allWorkOrders(client: Client): Promise<HistoryPage> {
  return page(client, "workOrders", { numItems: 100 });
}

// Requests for stock name no aircraft, so they are left out here.
function aircraftOf(pages: HistoryPage[]): string[] {
  const rows = pages.flatMap((p) => [
    ...p.records.flights,
    ...p.records.discrepancies,
    ...p.records.workOrders,
    ...p.records.partsRequests,
    ...p.records.flightPlans,
  ]);
  expect(rows.length).toBeGreaterThan(0);
  return [...new Set(rows.flatMap((r) => r.aircraftUuid || []))].sort();
}

// The caller's scoped whole history, the oracle's input: the workspace
// itself holds only the window since S7.
async function snapshotOf(role: Role): Promise<Snapshot> {
  const s = await as(role).query((ctx) =>
    legacySnapshot(ctx, (full) => scopedSnapshot(full)),
  );
  if (!s) throw new Error(`No snapshot for the ${role}.`);
  return s;
}

async function allPages(client: Client, kind: "flights", numItems: number) {
  const rows: Flight[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const next: HistoryPage = await page(client, kind, { cursor, numItems });
    rows.push(...next.records.flights);
    if (next.isDone) return rows;
    cursor = next.continueCursor;
  }
  throw new Error("Paging never finished.");
}

function oraclePages(s: Snapshot, kind: "flights"): Flight[] {
  const request = { kind, cursor: null, numItems: 100 } as const;
  return historyPage(s, request, NOW).records.flights;
}

function settle(call: Promise<unknown>): Promise<Outcome> {
  return call.then(
    (value) => ({ returned: value }),
    (error: unknown) => ({ refused: readMessage(error) }),
  );
}

function readMessage(error: unknown): string {
  if (error instanceof ConvexError) return String(error.data);
  return error instanceof Error ? error.message : String(error);
}

// Uuids follow a scrambled counter, so a tie's insertion order is not its
// uuid order. 7,919 is prime, so the first 65,536 never repeat.
function uuidOf(n: number): string {
  const hex = ((n * 7919) % 65_536).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

async function seedWorld(ctx: MutationCtx): Promise<World> {
  const counter = { next: 0 };
  const nextUuid = () => uuidOf(++counter.next);
  const program = demoSnapshot().programs![0];
  for (const [uuid, name] of [
    [P, "Program P"],
    [Q, "Program Q"],
  ])
    await ctx.db.insert("programs", { ...program, uuid, name });
  for (const uuid of [P1, P2, P3, Q1])
    await ctx.db.insert("aircraft", aircraftRow(uuid));
  const people = await seedPeople(ctx);
  for (const aircraftUuid of [P1, P2, P3, Q1])
    await seedAircraftRecords(ctx, aircraftUuid, people.ids, nextUuid);
  const filedOrder = await seedFiledOrder(ctx, people.ids.admin, nextUuid);
  for (const aircraftUuid of [P1, P2, P3, Q1])
    await seedPurchasing(ctx, aircraftUuid, people.ids, nextUuid);
  return { subjects: people.subjects, filedOrder, oldStart: OLD };
}

// One edge of each purchasing rule per aircraft (tests/fixtures/
// purchasingEdges.ts), counted toward its open work order, with the
// allocation rows the app writes beside each order; P1 also has a request
// for stock.
async function seedPurchasing(
  ctx: MutationCtx,
  aircraftUuid: string,
  ids: People,
  nextUuid: () => string,
) {
  const open = (await ctx.db
    .query("workOrders")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .collect())!.find((w) => w.status === "in-progress")!;
  const card = (await ctx.db
    .query("taskCards")
    .withIndex("workOrder", (q) => q.eq("workOrderUuid", open.uuid))
    .first())!;
  const edges = edgeRecords(
    {
      end: NOW,
      program: aircraftUuid === Q1 ? Q : P,
      admin: ids.admin,
      pilot: ids.pilot,
      aircraft: { ...aircraftRow(aircraftUuid), model: "206" },
      order: { uuid: open.uuid, card: card.uuid },
      component: nextUuid(),
      inspection: nextUuid(),
      stock: { uuid: nextUuid(), locationUuid: nextUuid(), partNumber: "F-1" },
      stockRequest: aircraftUuid === P1,
    },
    nextUuid,
  );
  for (const r of edges.partsRequests) {
    await ctx.db.insert("partsRequests", encode("partsRequests", r));
    await syncPurchasingKeys(ctx, "partsRequests", r);
  }
  for (const p of edges.purchaseOrders) {
    await ctx.db.insert("purchaseOrders", encode("purchaseOrders", p));
    await syncPurchasingKeys(ctx, "purchaseOrders", p);
  }
  for (const p of edges.flightPlans)
    await ctx.db.insert("flightPlans", encode("flightPlans", p));
  for (const f of edges.flights)
    await ctx.db.insert("flights", { ...f, ...flightColumns(f) });
}

function aircraftRow(uuid: string) {
  const base = demoSnapshot().aircraft[0];
  const programUuid = uuid === Q1 ? Q : P;
  return {
    ...base,
    uuid,
    registration: `N${uuid.slice(-1)}${programUuid.slice(-1).toUpperCase()}`,
    programUuid,
    program: programUuid === Q ? "Program Q" : "Program P",
  };
}

type People = Awaited<ReturnType<typeof seedPeople>>["ids"];

async function seedPeople(ctx: MutationCtx) {
  const group = (programUuid: string, name: string, extra: GroupFields) =>
    ctx.db.insert("groups", {
      programUuid,
      name,
      aircraftIds: [],
      permissions: ["read"],
      ...extra,
    });
  const all: Doc<"groups">["permissions"] = [
    "read",
    "flight",
    "discrepancy",
    "resolve",
    "maintenance",
  ];
  const groups = {
    admin: await group(P, "Admins", { programAdmin: true, permissions: all }),
    pilot: await group(P, "Pilots", {
      aircraftIds: [P1],
      permissions: ["read", "flight", "discrepancy"],
    }),
    mechanic: await group(P, "Mechanics", {
      permissions: ["read", "maintenance", "resolve"],
    }),
    owner: await group(P, "Owners", { owner: true, aircraftIds: [P1] }),
    board: await group(P, "Board", { board: true }),
    outsider: await group(Q, "Q admins", {
      programAdmin: true,
      permissions: all,
    }),
  };
  const subjects = {} as Record<Role, string>;
  const ids = {} as Record<Role | "former", Id<"users">>;
  for (const role of Object.keys(groups) as Role[]) {
    const programUuid = role === "outsider" ? Q : P;
    const account = await addAccount(ctx, role, [groups[role]], programUuid);
    subjects[role] = account.subject;
    ids[role] = account.id;
  }
  // Flew the old flights, then left: no group, no session.
  ids.former = await ctx.db.insert("users", {
    name: "Former pilot",
    email: "former@example.test",
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  return { subjects, ids };
}

async function addAccount(
  ctx: MutationCtx,
  role: Role,
  groupIds: Id<"groups">[],
  activeProgramUuid: string,
) {
  const id = await ctx.db.insert("users", {
    name: role,
    email: `${role}@example.test`,
    active: true,
    isAdmin: false,
    groupIds,
    activeProgramUuid,
  });
  await syncMemberships(ctx, id);
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime: NOW + DAY,
  });
  return { id, subject: `${id}|${session}` };
}

// Per aircraft: flights, reports and work orders on both sides of the
// window, with ties inside the older history.
async function seedAircraftRecords(
  ctx: MutationCtx,
  aircraftUuid: string,
  ids: People,
  nextUuid: () => string,
) {
  const flight = (start: number, extra: Partial<FlightRow> = {}) =>
    insertFlight(ctx, { aircraftUuid, start, uuid: nextUuid(), ...extra });
  await flight(OLD, { pilotId: ids.former });
  await flight(OLD, { pilotId: ids.pilot, copilotId: ids.mechanic });
  await flight(OLD, { pilotId: ids.pilot });
  await flight(OLD - DAY, { pilotId: ids.former });
  await flight(OLD - 2 * DAY, { status: "rejected", pilotId: ids.pilot });
  await flight(OLD - 3 * DAY, { status: "review", pilotId: ids.pilot });
  await flight(OLD - 4 * DAY, { submittedAt: RECENT, pilotId: ids.pilot });
  await flight(RECENT, { pilotId: ids.pilot });
  await seedReports(ctx, aircraftUuid, ids, nextUuid);
  await seedWorkOrders(ctx, aircraftUuid, ids.admin, nextUuid);
}

async function insertFlight(
  ctx: MutationCtx,
  fields: Partial<FlightRow> & { aircraftUuid: string; start: number },
) {
  const { start, ...rest } = fields;
  const flight: FlightRow = {
    uuid: uuidOf(start),
    authorId: rest.pilotId ?? "pilot",
    pilotId: "pilot",
    submittedAt: start,
    status: "accepted",
    startTime: new Date(start).toISOString(),
    landings: 1,
    cycles: 1,
    hobbsOn: 3600,
    origin: "KCHA",
    destination: "KAVL",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...rest,
  };
  await ctx.db.insert("flights", { ...flight, ...flightColumns(flight) });
}

async function seedReports(
  ctx: MutationCtx,
  aircraftUuid: string,
  ids: People,
  nextUuid: () => string,
) {
  const report = (createdAt: number, extra: Partial<Discrepancy>) =>
    ctx.db.insert("discrepancies", {
      uuid: nextUuid(),
      aircraftUuid,
      description: "Landing light flickers.",
      authorId: ids.pilot,
      createdAt,
      status: "resolved",
      resolution: "Replaced lamp.",
      resolvedBy: ids.mechanic,
      resolvedAt: createdAt + DAY,
      ...extra,
    });
  await report(OLD, {});
  await report(OLD, { authorId: ids.mechanic });
  await report(OLD - DAY, { resolvedAt: RECENT });
  await report(OLD - 2 * DAY, {
    status: "open",
    resolution: undefined,
    resolvedBy: undefined,
    resolvedAt: undefined,
  });
}

// Five newer completed orders hold the latest-five places, so the older
// ones below are history: ties on a date, one costed lately with an entry
// only administrators see, one cancelled without a date, one still open.
async function seedWorkOrders(
  ctx: MutationCtx,
  aircraftUuid: string,
  adminId: string,
  nextUuid: () => string,
) {
  const dates = ["2025-06-01", "2025-06-02", "2025-06-03", "2025-06-04"];
  for (const completionDate of [...dates, "2025-06-05"])
    await insertOrder(ctx, nextUuid, { aircraftUuid, completionDate }, adminId);
  for (const completionDate of ["2024-01-10", "2024-01-10", "2024-01-05"])
    await insertOrder(ctx, nextUuid, { aircraftUuid, completionDate }, adminId);
  const costed = { aircraftUuid, completionDate: "2024-01-08" };
  await insertOrder(ctx, nextUuid, costed, adminId, RECENT);
  const undated = { aircraftUuid, status: "cancelled" as const };
  await insertOrder(ctx, nextUuid, undated, adminId);
  const open = { aircraftUuid, status: "in-progress" as const };
  await insertOrder(ctx, nextUuid, open, adminId);
}

async function insertOrder(
  ctx: MutationCtx,
  nextUuid: () => string,
  fields: Partial<WorkOrder> & { aircraftUuid: string },
  adminId: string,
  otherCostAt?: number,
): Promise<WorkOrder> {
  const w = workOrderSchema.parse({
    ...ORDER_TEXT,
    uuid: nextUuid(),
    number: `WO-${counterOf(fields.aircraftUuid)}-${nextUuid().slice(-4)}`,
    status: fields.completionDate ? "completed" : "open",
    completionDate: "",
    recordedAt: OLD - 30 * DAY,
    createdBy: adminId,
    ...fields,
  });
  await ctx.db.insert("workOrders", encode("workOrders", w));
  for (let i = 0; i < 2; i++)
    await ctx.db.insert("taskCards", encode("taskCards", card(w, nextUuid())));
  await ctx.db.insert(
    "costs",
    encode("costs", cost(w, nextUuid(), adminId, otherCostAt)),
  );
  return w;
}

function counterOf(aircraftUuid: string) {
  return aircraftUuid.slice(-1);
}

// An older order on P2 with an archived job card, evidence, a file and a
// parts request raised from it.
async function seedFiledOrder(
  ctx: MutationCtx,
  adminId: string,
  nextUuid: () => string,
): Promise<string> {
  const fields = { aircraftUuid: P2, completionDate: "2023-05-01" };
  const w = await insertOrder(ctx, nextUuid, fields, adminId);
  const archived = card(w, nextUuid());
  await ctx.db.insert(
    "archivedTaskCards",
    encode("archivedTaskCards", archived),
  );
  const storageId = await ctx.storage.store(new Blob(["%PDF-1.4 evidence"]));
  const file = { aircraftUuid: P2, storageId, size: 17, uploadedAt: OLD };
  await ctx.db.insert("taskEvidence", {
    ...file,
    taskCardUuid: archived.uuid,
    name: "photo.pdf",
    category: "photo",
  });
  await ctx.db.insert("workOrderFiles", {
    ...file,
    workOrderUuid: w.uuid,
    name: "release.pdf",
  });
  const request = partsRequest(w, nextUuid(), adminId);
  await ctx.db.insert("partsRequests", encode("partsRequests", request));
  return w.uuid;
}

const ORDER_TEXT = {
  version: 1,
  dateOpened: "2023-01-01",
  supervisor: "Chief inspector",
  scope: "100-hour inspection.",
  priority: "routine",
  releaseOutcome: "Approved for return to service.",
  finalReview: "",
  aircraft: {
    registration: "N1",
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
};

function card(w: WorkOrder, uuid: string) {
  return taskCardSchema.parse({
    ...taskCardDefaults(w.aircraftUuid),
    uuid,
    version: 1,
    createdBy: w.createdBy,
    createdAt: OLD - 30 * DAY,
    updatedAt: OLD - 30 * DAY,
    cardNumber: `JC-${uuid.slice(-6)}`,
    title: "Inspect the engine compartment",
    workOrderUuid: w.uuid,
    status: "completed",
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  });
}

function cost(
  w: WorkOrder,
  uuid: string,
  adminId: string,
  otherAt: number | undefined,
) {
  const at = OLD - 30 * DAY;
  return costRecordSchema.parse({
    uuid,
    version: 1,
    programUuid: w.aircraftUuid === Q1 ? Q : P,
    kind: "workOrder",
    aircraftUuid: w.aircraftUuid,
    workOrderUuid: w.uuid,
    labor: [
      {
        uuid: `${uuid.slice(0, -1)}a`,
        date: "2024-01-10",
        technician: "Mechanic",
        minutes: 60,
        rateCents: 9500,
        createdBy: adminId,
        createdAt: at,
      },
    ],
    other:
      otherAt === undefined
        ? []
        : [
            {
              uuid: `${uuid.slice(0, -1)}b`,
              date: "2024-01-10",
              description: "Hangar fee",
              amountCents: 5000,
              createdBy: adminId,
              createdAt: otherAt,
            },
          ],
    partUnitCosts: [],
  });
}

function partsRequest(w: WorkOrder, uuid: string, adminId: string) {
  return partsRequestSchema.parse({
    uuid,
    version: 1,
    mode: "parts",
    date: "2023-04-20",
    engineer: "Mechanic",
    base: "Test Field",
    priority: "P2 Routine",
    requiredBy: "2023-05-01",
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
    programUuid: P,
    cancelled: false,
    source: { kind: "workTask", uuid: "", workOrderUuid: w.uuid },
    lines: [
      {
        uuid: `${uuid.slice(0, -1)}c`,
        partNumber: "LT-4000",
        description: "Oil filter",
        quantity: 1,
        quotedCents: 2495,
      },
    ],
    history: [],
    aircraftUuid: w.aircraftUuid,
    sourceLabel: w.number,
    aircraftRegistration: "N2",
    aircraftSerial: "2",
    aircraftModel: "206",
    number: `PR-${uuid.slice(-4)}`,
    requesterId: adminId,
    createdAt: OLD,
    updatedAt: OLD,
    reservations: [],
    issues: [],
  });
}
