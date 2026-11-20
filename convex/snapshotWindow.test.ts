/**
 * Responsibility: Pins the windowed workspace snapshot against whole history
 *   at three fleet-years: for every kind of caller it equals the whole load
 *   narrowed by the retention window, purchasing and flight plans included,
 *   and across the window's day boundary the workspace and the history pages
 *   leave no record out.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (schema, _generated, collections), tests/fixtures
 *   (programVolume, purchasingEdges, legacySnapshot, historyPages),
 *   src/domain (retention, programs).
 *
 * The oracle is the server's whole-history load as it was before S7
 * (tests/fixtures/legacySnapshot.ts), so the windowed loaders are checked
 * against the rule over everything, not against themselves (ADR-0013).
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { decode, derivedColumns } from "./collections";
import {
  seedProgramVolume,
  VOLUME_PROGRAM,
} from "../tests/fixtures/programVolume";
import { legacySnapshot } from "../tests/fixtures/legacySnapshot";
import { queryHistoryPage } from "../tests/fixtures/historyPages";
import { EDGES, edgeLabel } from "../tests/fixtures/purchasingEdges";
import {
  retainedSnapshot,
  emptyHistoryRecords,
  retentionCutoff,
  RETENTION_DAYS,
  type HistoryKind,
  type HistoryRecords,
} from "../src/domain/retention";
import { scopedSnapshot } from "../src/domain/programs";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;
const MINUTE = 60_000;
const YEARS = 3;
// About 22,000 rows on a shared machine, then the backfill.
const SEED_TIMEOUT_MS = 240_000;
const ROLE_TIMEOUT_MS = 60_000;
const PAGE = 100;
const MAX_PAGES = 200;
const ROLES = ["admin", "pilot", "mechanic", "owner", "board"] as const;
const LISTS = {
  flights: ["flights"],
  discrepancies: ["discrepancies"],
  workOrders: ["workOrders", "taskCards", "archivedTaskCards"],
  partsRequests: ["partsRequests"],
  purchaseOrders: ["purchaseOrders"],
  flightPlans: ["flightPlans"],
} as const satisfies Record<HistoryKind, readonly (keyof HistoryRecords)[]>;

const DERIVED_TABLES = [
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
  "partsRequests",
  "purchaseOrders",
  "flightPlans",
] as const;

type Role = (typeof ROLES)[number];

let t: TestConvex<typeof schema>;
let subjects: Record<Role, string>;

beforeAll(async () => {
  vi.useFakeTimers({ now: SEEDED_AT });
  t = convexTest(schema, modules);
  const { accounts } = await t.run((ctx) =>
    seedProgramVolume(ctx, SEEDED_AT, YEARS),
  );
  subjects = { ...accounts, mechanic: await t.run(seedMechanic) };
  await t.action(internal.migrations.backfillHistoryColumns, {});
}, SEED_TIMEOUT_MS);

afterAll(() => vi.useRealTimers());

describe("the workspace at three fleet-years of history", () => {
  it.each(ROLES)(
    "equals the whole load narrowed by the window for the %s",
    async (role) => {
      const client = t.withIdentity({ subject: subjects[role] });
      const served = await client.query(api.operations.snapshot, {});
      const windowed = await client.query((ctx) =>
        legacySnapshot(ctx, (full, today) =>
          scopedSnapshot(retainedSnapshot(full, SEEDED_AT), today),
        ),
      );
      expect(served).toEqual(windowed);
    },
    ROLE_TIMEOUT_MS,
  );

  it("keeps only part of the history it used to load", async () => {
    const client = t.withIdentity({ subject: subjects.admin });
    const served = (await client.query(api.operations.snapshot, {}))!;
    const whole = (await client.query((ctx) =>
      legacySnapshot(ctx, (full) => scopedSnapshot(full)),
    ))!;
    for (const key of HALVED)
      expect(served[key]!.length, key).toBeLessThan(whole[key]!.length / 2);
  });

  // Each edge stands for one rule; every edge aircraft holds them all.
  it("keeps each purchasing edge its rule keeps, and no other", async () => {
    const client = t.withIdentity({ subject: subjects.admin });
    const served = (await client.query(api.operations.snapshot, {}))!;
    const labels = {
      requests: (served.partsRequests ?? []).map((r) => edgeLabel(r.number)),
      orders: (served.purchaseOrders ?? []).map((p) => edgeLabel(p.number)),
      plans: (served.flightPlans ?? []).map((p) => edgeLabel(p.sourceName)),
    };
    for (const list of ["requests", "orders", "plans"] as const) {
      for (const label of EDGES.kept[list])
        expect(labels[list], `${list} ${label}`).toContain(label);
      for (const label of EDGES.paged[list])
        expect(labels[list], `${list} ${label}`).not.toContain(label);
    }
  });
});

describe("the window's day boundary", () => {
  it(
    "overlaps an older workspace with newer pages, leaving nothing out",
    async () => {
      const midnight = retentionCutoff(SEEDED_AT, 0) + DAY;
      const client = t.withIdentity({ subject: subjects.admin });
      vi.setSystemTime(midnight - MINUTE);
      const before = (await client.query(api.operations.snapshot, {}))!;
      const whole = (await client.query((ctx) =>
        legacySnapshot(ctx, (full) => scopedSnapshot(full)),
      ))!;
      vi.setSystemTime(midnight + MINUTE);
      const after = (await client.query(api.operations.snapshot, {}))!;
      expect(retentionCutoff(midnight + MINUTE, RETENTION_DAYS)).toBe(
        retentionCutoff(midnight - MINUTE, RETENTION_DAYS) + DAY,
      );
      for (const kind of Object.keys(LISTS) as HistoryKind[]) {
        const pages = await pageAll(client, kind);
        for (const key of LISTS[kind]) {
          const covered = new Set([
            ...uuids(before[key]),
            ...uuids(pages[key]),
          ]);
          expect(
            uuids(whole[key]).filter((u) => !covered.has(u)),
            key,
          ).toEqual([]);
          const now = new Set([...uuids(after[key]), ...uuids(pages[key])]);
          expect(now.size, key).toBe(uuids(whole[key]).length);
        }
      }
      vi.setSystemTime(SEEDED_AT);
    },
    ROLE_TIMEOUT_MS,
  );
});

describe("before the backfill", () => {
  it(
    "reads rows without their columns rather than leaving them out",
    async () => {
      const fresh = convexTest(schema, modules);
      const { accounts } = await fresh.run((ctx) =>
        seedProgramVolume(ctx, SEEDED_AT, 1),
      );
      const mechanic = await fresh.run(seedMechanic);
      await fresh.run(forgetEveryColumn);
      const roles: Record<Role, string> = { ...accounts, mechanic };
      for (const role of ROLES) {
        const client = fresh.withIdentity({ subject: roles[role] });
        expect(await client.query(api.operations.snapshot, {}), role).toEqual(
          await client.query((ctx) =>
            legacySnapshot(ctx, (full, today) =>
              scopedSnapshot(retainedSnapshot(full, SEEDED_AT), today),
            ),
          ),
        );
      }
    },
    SEED_TIMEOUT_MS,
  );
});

// The history and purchasing the window cuts to under half at three years.
const HALVED = [
  "flights",
  "workOrders",
  "taskCards",
  "partsRequests",
  "purchaseOrders",
  "flightPlans",
] as const;

// A mechanic on the second and third aircraft: maintenance without money,
// so their cost records lose rates and other costs.
async function seedMechanic(ctx: MutationCtx): Promise<string> {
  const group = await ctx.db.insert("groups", {
    programUuid: VOLUME_PROGRAM,
    name: "Mechanics",
    aircraftIds: ["volume-aircraft-2", "volume-aircraft-3"],
    permissions: ["read", "maintenance"],
  });
  const id = await ctx.db.insert("users", {
    name: "Mechanic",
    email: "mechanic@example.test",
    active: true,
    isAdmin: false,
    activeProgramUuid: VOLUME_PROGRAM,
    groupIds: [group],
  });
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime: SEEDED_AT + DAY,
  });
  return `${id}|${session}`;
}

// Strips the derived columns from every row that has them, and the derived
// allocation rows, as rows written before S2 were stored; the fixture's
// flights are stored without them.
async function forgetEveryColumn(ctx: MutationCtx): Promise<void> {
  for (const table of DERIVED_TABLES)
    for (const row of await ctx.db.query(table).collect()) {
      const [record] = decode(table, [row]);
      const columns = Object.keys(derivedColumns(table, record));
      await ctx.db.patch(
        row._id,
        Object.fromEntries(columns.map((key) => [key, undefined])),
      );
    }
  for (const row of await ctx.db.query("purchaseAllocations").collect())
    await ctx.db.delete(row._id);
}

// Every page of a list's older history, as one set of records.
async function pageAll(
  client: ReturnType<typeof t.withIdentity>,
  kind: HistoryKind,
): Promise<HistoryRecords> {
  let rows = emptyHistoryRecords();
  let cursor: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const { records, isDone, continueCursor } = await queryHistoryPage(
      client,
      kind,
      { programUuid: VOLUME_PROGRAM, cursor, numItems: PAGE },
    );
    rows = appendRecords(rows, records);
    if (isDone) return rows;
    cursor = continueCursor;
  }
  throw new Error(`The ${kind} pages never finished.`);
}

function appendRecords(
  rows: HistoryRecords,
  page: HistoryRecords,
): HistoryRecords {
  const all = emptyHistoryRecords();
  for (const key of Object.keys(all) as (keyof HistoryRecords)[])
    Object.assign(all, { [key]: [...rows[key], ...page[key]] });
  return all;
}

function uuids(rows: { uuid: string }[] | undefined): string[] {
  return (rows ?? []).map((r) => r.uuid);
}
