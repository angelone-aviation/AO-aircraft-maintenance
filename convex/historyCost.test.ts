/**
 * Responsibility: Pins what the workspace snapshot and the saves that once
 *   loaded whole history read at one, two and three fleet-years.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (operations, historyWindow, programContext, schema,
 *   migrations), tests/fixtures (programVolume, volumeSaves), src/domain
 *   (programs).
 *
 * The counts are convex-test's transaction metrics: documents and bytes read
 * as Convex counts them against its 16 MiB limit, and index ranges against
 * its 4,096. They began as the baseline for history paging (ADR-0013,
 * docs/history-paging.md); each stage that bounded a read turned its growth
 * into a flat line, and these tests flipped with it. Each database runs the
 * backfill first, as a deployment does before the window is trusted.
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { snapshot } from "./operations";
import { internal } from "./_generated/api";
import { windowedHistory } from "./historyWindow";
import { context } from "./programContext";
import { activeProgram } from "../src/domain/programs";
import { seedProgramVolume, VOLUME } from "../tests/fixtures/programVolume";
import {
  findVolumeTargets,
  volumeOperations,
  type VolumeOperation,
} from "../tests/fixtures/volumeSaves";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const YEARS = [1, 2, 3] as const;
const ROLES = ["admin", "pilot", "owner", "board"] as const;
// Three databases of up to about 22,000 rows each on a shared machine.
const SEED_TIMEOUT_MS = 180_000;
const FLAT = 1.1;
// The plan's headroom on Convex's 4,096 index ranges a function may read
// (ADR-0013): a quarter of the limit.
const INDEX_RANGE_BAR = 1000;
// The parts requests and purchase orders each fleet-year adds.
const PURCHASING_ROWS_PER_YEAR =
  VOLUME.aircraft * (VOLUME.partsRequests + VOLUME.purchaseOrders);

type Reads = { documents: number; bytes: number; indexRanges: number };
type Handler<C> = (ctx: C, args: object) => Promise<unknown>;

const reads = new Map<string, Record<string, Reads>>();

beforeAll(async () => {
  vi.useFakeTimers({ now: SEEDED_AT });
  for (const years of YEARS) await measureYear(years);
}, SEED_TIMEOUT_MS);

afterAll(() => vi.useRealTimers());

it("matches the recorded reads", async () => {
  await expect(
    JSON.stringify(Object.fromEntries(reads), null, 1),
  ).toMatchFileSnapshot("./__golden__/historyCost.json");
});

describe("the windowed workspace (S7, H5)", () => {
  it("reads the window's history the same at three years as at one", () =>
    expectFlat("snapshot.window"));

  // Since H5's window, parts requests, purchase orders and flight plans are
  // read by the window's indexes too, so no view grows with history at this
  // volume (its ADs record no compliance and no component moves).
  it.each(ROLES)("the %s's snapshot reads the same", (role) =>
    expectFlat(`snapshot.${role}`),
  );
});

// Files are read by program and by work order, not one range per record
// (convex/fileColumns.ts), so no view nears the limit.
it.each(ROLES)(
  "the %s's snapshot reads at most a quarter of Convex's index ranges",
  (role) => {
    for (const { indexRanges } of yearsOf(`snapshot.${role}`))
      expect(indexRanges).toBeLessThanOrEqual(INDEX_RANGE_BAR);
  },
);

describe("the bounded saves read the same at three years as at one (S3)", () => {
  it.each([
    "workOrder.save",
    "taskCard.save",
    "taskCard.evidence",
    "cost.partUnitCost",
    "auditHistory.weeklySummary",
    "history.costReport",
  ])("%s", (operation) => expectFlat(operation));
});

// H5 keeps parts requests and purchase orders complete, and these saves read
// them all; everything else they read is bounded.
describe("Characterizes current behaviour: saves that read every parts request and purchase order grow by those alone", () => {
  it.each(["partsRequest.save", "purchaseOrder.save"])("%s", (operation) =>
    expectGrowthOf(operation, PURCHASING_ROWS_PER_YEAR),
  );
});

// The plan's bar for a bounded read (ADR-0013): within 10% of year 1.
function expectFlat(name: string) {
  const [one, , three] = yearsOf(name);
  expect(three.documents, name).toBeLessThanOrEqual(one.documents * FLAT);
  expect(three.bytes, name).toBeLessThanOrEqual(one.bytes * FLAT);
  expectSameRanges(name);
}

function expectGrowthOf(name: string, documentsPerYear: number) {
  const [one, two, three] = yearsOf(name);
  expect(
    [two.documents - one.documents, three.documents - two.documents],
    name,
  ).toEqual([documentsPerYear, documentsPerYear]);
  expectSameRanges(name);
}

function expectSameRanges(name: string) {
  const [one, two, three] = yearsOf(name);
  expect([two.indexRanges, three.indexRanges], name).toEqual([
    one.indexRanges,
    one.indexRanges,
  ]);
}

function yearsOf(name: string) {
  return YEARS.map((years) => reads.get(name)![years]);
}

async function measureYear(years: number) {
  const t = convexTest(schema, modules);
  const { accounts } = await t.run((ctx) =>
    seedProgramVolume(ctx, SEEDED_AT, years),
  );
  await t.action(internal.migrations.backfillHistoryColumns, {});
  const targets = await t.run(findVolumeTargets);
  for (const role of ROLES)
    await measure(t, years, accounts[role], {
      name: `snapshot.${role}`,
      kind: "query",
      fn: snapshot,
      args: {},
    });
  for (const operation of volumeOperations(targets))
    await measure(t, years, accounts.admin, operation);
  record("snapshot.window", years, await windowReads(t, accounts.admin));
}

// The administrator's windowed history alone, without the collections that
// stay complete.
function windowReads(
  t: TestConvex<typeof schema>,
  subject: string,
): Promise<Reads> {
  return t.withIdentity({ subject }).query(async (ctx) => {
    const state = await context(ctx);
    const before = await ctx.meta.getTransactionMetrics();
    const fleet = state.aircraft;
    const scope = { program: activeProgram(state), fleet, readable: fleet };
    await windowedHistory(ctx, scope, Date.now());
    const after = await ctx.meta.getTransactionMetrics();
    return {
      documents: after.documentsRead.used - before.documentsRead.used,
      bytes: after.bytesRead.used - before.bytesRead.used,
      indexRanges: after.databaseQueries.used - before.databaseQueries.used,
    };
  });
}

async function measure(
  t: ReturnType<typeof convexTest>,
  years: number,
  subject: string,
  operation: VolumeOperation,
) {
  record(operation.name, years, await readsOf(t, subject, operation));
}

function record(name: string, years: number, measured: Reads) {
  reads.set(name, { ...reads.get(name), [years]: measured });
}

// Runs a registered function's handler inside an inline transaction, so the
// transaction's metrics are its own.
function readsOf(
  t: ReturnType<typeof convexTest>,
  subject: string,
  { kind, fn, args }: VolumeOperation,
): Promise<Reads> {
  const as = t.withIdentity({ subject });
  return kind === "query"
    ? as.query((ctx) => measured(ctx, fn, args))
    : as.mutation((ctx) => measured(ctx, fn, args));
}

// Convex keeps a registered function's handler on `_handler`; calling it
// directly is the only way to read the metrics of its transaction after it.
async function measured<C extends Pick<QueryCtx, "meta">>(
  ctx: C,
  fn: unknown,
  args: object,
): Promise<Reads> {
  await (fn as { _handler: Handler<C> })._handler(ctx, args);
  const metrics = await ctx.meta.getTransactionMetrics();
  return {
    documents: metrics.documentsRead.used,
    bytes: metrics.bytesRead.used,
    indexRanges: metrics.databaseQueries.used,
  };
}
