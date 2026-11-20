/**
 * Responsibility: Pins the paged history queries against historyPage on the
 *   size test's two-fleet-year program: page for page, and with the window
 *   every record exactly once.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex (schema, operations, migrations, history, _generated),
 *   tests/fixtures/programVolume.ts, tests/fixtures/historyPages.ts,
 *   src/domain (retention, model).
 *
 * The fixture stores flights without their derived column, as rows written
 * before S2 are, so the backfill runs first, as on a deployment.
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  seedProgramVolume,
  VOLUME_PROGRAM,
  type VolumeAccounts,
} from "../tests/fixtures/programVolume";
import { expectOraclePages } from "../tests/fixtures/historyPages";
import { retainedSnapshot, type HistoryRecords } from "../src/domain/retention";
import type { Snapshot } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const YEARS = 2;
const PAGE = 20;
// About 15,000 rows on a shared machine, then the backfill.
const SEED_TIMEOUT_MS = 180_000;
const PAGING_TIMEOUT_MS = 120_000;
const COLLECTIONS = [
  "flights",
  "discrepancies",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
] as const;

let t: TestConvex<typeof schema>;
let accounts: VolumeAccounts;

beforeAll(async () => {
  vi.useFakeTimers({ now: SEEDED_AT });
  t = convexTest(schema, modules);
  ({ accounts } = await t.run((ctx) =>
    seedProgramVolume(ctx, SEEDED_AT, YEARS),
  ));
  await t.action(internal.migrations.backfillHistoryColumns, {});
}, SEED_TIMEOUT_MS);

afterAll(() => vi.useRealTimers());

describe("two fleet-years of history", () => {
  it.each(["admin", "pilot"] as const)(
    "pages the %s's older records as historyPage does, and the window and pages hold each record once",
    async (role) => {
      const client = t.withIdentity({ subject: accounts[role] });
      const s = (await client.query(api.operations.snapshot, {}))!;
      const paged = await pageEveryList(client, s);
      const kept = retainedSnapshot(s, SEEDED_AT);
      for (const key of COLLECTIONS) {
        const keptUuids = uuids(kept[key]);
        const pagedUuids = uuids(paged[key]);
        expect(
          pagedUuids.filter((u) => keptUuids.includes(u)),
          key,
        ).toEqual([]);
        expect([...keptUuids, ...pagedUuids].sort(), key).toEqual(
          uuids(s[key]).sort(),
        );
      }
      expect(paged.flights.length).toBeGreaterThan(PAGE);
      expect(paged.workOrders.length).toBeGreaterThan(PAGE);
    },
    PAGING_TIMEOUT_MS,
  );
});

async function pageEveryList(
  client: ReturnType<typeof t.withIdentity>,
  s: Snapshot,
): Promise<HistoryRecords> {
  const lists = [];
  for (const kind of ["flights", "discrepancies", "workOrders"] as const)
    lists.push(
      await expectOraclePages(
        client,
        s,
        { programUuid: VOLUME_PROGRAM, kind, cursor: null, numItems: PAGE },
        SEEDED_AT,
      ),
    );
  const [flights, reports, orders] = lists;
  return {
    ...orders,
    flights: flights.flights,
    discrepancies: reports.discrepancies,
  };
}

function uuids(rows: { uuid: string }[] | undefined): string[] {
  return (rows ?? []).map((r) => r.uuid);
}
