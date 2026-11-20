/**
 * Responsibility: Characterizes what the workspace snapshot and the saves
 *   that load whole history read at one, two and three fleet-years.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (operations, schema), tests/fixtures (programVolume,
 *   volumeSaves).
 *
 * The counts are convex-test's transaction metrics: documents and bytes read
 * as Convex counts them against its 16 MiB limit, and index ranges against
 * its 4,096. They are the baseline for history paging (ADR-0013,
 * docs/history-paging.md): each stage that bounds a read turns its growth
 * into a flat line, and these tests flip with it.
 */
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { snapshot } from "./operations";
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

it("matches the reads recorded before history paging", async () => {
  await expect(
    JSON.stringify(Object.fromEntries(reads), null, 1),
  ).toMatchFileSnapshot("./__golden__/historyCost.json");
});

describe("Characterizes current behaviour: reads grow with each year of history", () => {
  it.each(ROLES)("the %s's workspace snapshot", (role) =>
    expectGrowth(`snapshot.${role}`),
  );
});

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

// Documents and bytes rise every year. Index ranges do not: each loader
// reads one range per aircraft or program, however many rows it holds, so
// the 16 MiB read limit, not the range limit, is the one history reaches.
function expectGrowth(name: string) {
  const [one, two, three] = yearsOf(name);
  expect(two.documents, name).toBeGreaterThan(one.documents);
  expect(three.documents, name).toBeGreaterThan(two.documents);
  expect(two.bytes, name).toBeGreaterThan(one.bytes);
  expect(three.bytes, name).toBeGreaterThan(two.bytes);
  expectSameRanges(name);
}

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
}

async function measure(
  t: ReturnType<typeof convexTest>,
  years: number,
  subject: string,
  operation: VolumeOperation,
) {
  const measured = await readsOf(t, subject, operation);
  reads.set(operation.name, {
    ...reads.get(operation.name),
    [years]: measured,
  });
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
