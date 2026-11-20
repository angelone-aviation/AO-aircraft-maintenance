/**
 * Responsibility: Pins the demo's history reads to the domain oracle: they
 *   scope the full snapshot first, as the server's workspace does, then page
 *   exactly as historyPage pages it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/demoHistory.ts, src/data/demo.ts (seed), src/domain
 *   (retention, historyReads, programs, record schemas).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo";
import { demoHistoryCalls } from "./demoHistory";
import {
  historyPage,
  retainedSnapshot,
  type HistoryKind,
  type HistoryPageRequest,
  type HistoryRecords,
} from "../domain/retention";
import { flightRange, workOrderHistory } from "../domain/historyReads";
import { scopedSnapshot } from "../domain/programs";
import type { Flight, Snapshot } from "../domain/model";
import { workOrderSchema, type WorkOrder } from "../domain/workOrders";
import { costRecordSchema } from "../domain/costs";

const NOW = Date.UTC(2026, 10, 19, 15, 30);
const DAY = 86_400_000;
const OLD = Date.UTC(2024, 2, 1, 12);
const [N206, N208] = ["demo-206", "demo-208"];
const KINDS = ["flights", "discrepancies", "workOrders"] as const;
const MAX_PAGES = 100;
const COLLECTIONS = [
  "flights",
  "discrepancies",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
] as const;

beforeAll(() => vi.useFakeTimers({ now: NOW }));
afterAll(() => vi.useRealTimers());

describe("the demo's history reads", () => {
  it.each([2, 5])(
    "page what historyPage pages on the scoped snapshot, %i at a time, and with the window hold everything once",
    async (numItems) => {
      const all = agedDemo();
      const calls = demoHistoryCalls(async () => all);
      const scoped = scopedSnapshot(all);
      const kept = retainedSnapshot(scoped, NOW);
      const paged = await followEvery(calls.historyPage, scoped, numItems);
      for (const key of COLLECTIONS)
        expect([...uuids(kept[key]), ...uuids(paged[key])].sort(), key).toEqual(
          uuids(scoped[key]).sort(),
        );
      expect(paged.flights.length).toBeGreaterThan(numItems);
      expect(paged.workOrders.length).toBeGreaterThan(0);
    },
  );

  it("scope the snapshot to the signed-in member before paging", async () => {
    const all = asPilotOf(agedDemo(), N206);
    const calls = demoHistoryCalls(async () => all);
    const request = { kind: "flights", cursor: null, numItems: 100 } as const;
    const page = await calls.historyPage(request);
    expect(new Set(page.records.flights.map((f) => f.aircraftUuid))).toEqual(
      new Set([N206]),
    );
    await expect(
      calls.historyPage({ ...request, aircraftUuid: N208 }),
    ).rejects.toThrow("History not found.");
    const orders = await calls.historyPage({ ...request, kind: "workOrders" });
    expect(JSON.stringify(orders.records.costs)).not.toContain("rateCents");
  });

  it("read one work order and a span of flights as the domain does", async () => {
    const all = agedDemo();
    const scoped = scopedSnapshot(all);
    const calls = demoHistoryCalls(async () => all);
    const uuid = all.workOrders![0].uuid;
    expect(await calls.workOrderHistory(uuid)).toEqual(
      workOrderHistory(scoped, uuid),
    );
    const span = { aircraftUuid: N206, from: OLD - 3 * DAY, to: OLD + DAY };
    const range = await calls.flightsInRange(span);
    expect(range).toEqual(flightRange(scoped, span));
    expect(range.flights.length).toBeGreaterThan(0);
  });
});

// Follows the demo's and the oracle's cursors in step for every list.
async function followEvery(
  read: (request: HistoryPageRequest) => Promise<unknown>,
  scoped: Snapshot,
  numItems: number,
): Promise<HistoryRecords> {
  const pages: HistoryRecords[] = [];
  for (const kind of KINDS)
    pages.push(...(await follow(read, scoped, kind, numItems)));
  return {
    flights: pages.flatMap((p) => p.flights),
    discrepancies: pages.flatMap((p) => p.discrepancies),
    workOrders: pages.flatMap((p) => p.workOrders),
    taskCards: pages.flatMap((p) => p.taskCards),
    archivedTaskCards: pages.flatMap((p) => p.archivedTaskCards),
    costs: pages.flatMap((p) => p.costs),
  };
}

async function follow(
  read: (request: HistoryPageRequest) => Promise<unknown>,
  scoped: Snapshot,
  kind: HistoryKind,
  numItems: number,
): Promise<HistoryRecords[]> {
  const pages: HistoryRecords[] = [];
  let request: HistoryPageRequest = { kind, cursor: null, numItems };
  for (let n = 0; n < MAX_PAGES; n++) {
    const expected = historyPage(scoped, request, NOW);
    expect(await read(request)).toEqual(expected);
    pages.push(expected.records);
    if (expected.isDone) return pages;
    request = { ...request, cursor: expected.continueCursor };
  }
  throw new Error("Paging never finished.");
}

function uuids(rows: { uuid: string }[] | undefined): string[] {
  return (rows ?? []).map((r) => r.uuid);
}

// The pilot signed in, their group cut to one aircraft.
function asPilotOf(s: Snapshot, aircraftUuid: string): Snapshot {
  const pilot = s.members.find((m) => m.id === "demo-pilot")!;
  return {
    ...s,
    user: pilot,
    groups: s.groups.map((g) => ({ ...g, aircraftIds: [aircraftUuid] })),
  };
}

// The demo seed with records older than the window on two aircraft, ties
// included, beside recent ones it keeps.
function agedDemo(): Snapshot {
  const s = demoSnapshot();
  let n = 0;
  const uuid = () =>
    `00000000-0000-4000-8000-${(++n * 7919).toString(16).padStart(12, "0")}`;
  for (const aircraftUuid of [N206, N208]) {
    for (const start of [OLD, OLD, OLD - DAY, OLD - 2 * DAY, NOW - DAY])
      s.flights.push(flight(uuid(), aircraftUuid, start));
    for (const createdAt of [OLD, OLD, OLD - DAY])
      s.discrepancies.push({
        uuid: uuid(),
        aircraftUuid,
        description: "Landing light flickers.",
        authorId: "demo-pilot",
        createdAt,
        status: "resolved",
        resolution: "Replaced lamp.",
        resolvedBy: "demo-admin",
        resolvedAt: createdAt + DAY,
      });
    const dates = [
      "2025-06-01",
      "2025-06-02",
      "2025-06-03",
      "2025-06-04",
      "2025-06-05",
      "2024-01-10",
      "2024-01-10",
    ];
    for (const completionDate of dates) {
      const w = order(uuid(), aircraftUuid, completionDate);
      s.workOrders = [...(s.workOrders ?? []), w];
      s.costs = [...(s.costs ?? []), cost(uuid(), w)];
    }
  }
  return s;
}

function flight(uuid: string, aircraftUuid: string, start: number): Flight {
  return {
    uuid,
    aircraftUuid,
    authorId: "demo-pilot",
    pilotId: "demo-pilot",
    submittedAt: start,
    status: "accepted",
    startTime: new Date(start).toISOString(),
    landings: 1,
    cycles: 1,
    origin: "KCHA",
    destination: "KAVL",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
}

function order(
  uuid: string,
  aircraftUuid: string,
  completionDate: string,
): WorkOrder {
  return workOrderSchema.parse({
    uuid,
    version: 1,
    number: `WO-${uuid.slice(-4)}`,
    aircraftUuid,
    dateOpened: "2023-01-01",
    supervisor: "Chief inspector",
    scope: "100-hour inspection.",
    priority: "routine",
    status: "completed",
    completionDate,
    releaseOutcome: "Approved for return to service.",
    finalReview: "",
    recordedAt: OLD - 30 * DAY,
    createdBy: "demo-admin",
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
  });
}

function cost(uuid: string, w: WorkOrder) {
  return costRecordSchema.parse({
    uuid,
    version: 1,
    programUuid: "demo-program",
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
        createdBy: "demo-admin",
        createdAt: OLD - 30 * DAY,
      },
    ],
    other: [],
    partUnitCosts: [],
  });
}
