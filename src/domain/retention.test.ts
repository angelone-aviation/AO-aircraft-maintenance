/**
 * Responsibility: Pins the history retention window: the cutoff, what the
 *   workspace keeps of each record kind, and that the history pages hold
 *   exactly what it leaves out, once and in list order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/retention.ts, src/data/demo.ts (seed), src/domain
 *   schemas (work orders, close-out, job cards, costs).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  FLIGHT_RETENTION_DAYS,
  MAX_HISTORY_PAGE_SIZE,
  RETENTION_DAYS,
  historyPage,
  retainedSnapshot,
  retentionCutoff,
  type HistoryPageRequest,
  type HistoryRecords,
} from "./retention";
import type { Discrepancy, Flight, Snapshot } from "./model";
import { workOrderSchema, type WorkOrder } from "./workOrders";
import { closeoutSchema } from "./workOrderCloseoutSchema";
import { taskCardDefaults, taskCardSchema, type TaskCard } from "./taskCards";
import { costRecordSchema, type CostRecord } from "./costs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 15, 30);
const CUTOFF = Date.UTC(2026, 7, 21);
const FLIGHT_CUTOFF = Date.UTC(2026, 4, 20);
const LONG_AGO = Date.UTC(2024, 0, 15);
const MAX_PAGES = 1000;
const [A, B] = ["aircraft-a", "aircraft-b"];
const COLLECTIONS = [
  "flights",
  "discrepancies",
  "workOrders",
  "taskCards",
  "archivedTaskCards",
  "costs",
] as const;

describe("retentionCutoff", () => {
  it("rounds down to the start of the UTC day the window opens on", () => {
    expect(retentionCutoff(NOW, RETENTION_DAYS)).toBe(CUTOFF);
    expect(retentionCutoff(NOW, FLIGHT_RETENTION_DAYS)).toBe(FLIGHT_CUTOFF);
  });

  it("keeps one cutoff all day and moves it a whole day at midnight", () => {
    const midnight = Date.UTC(2026, 10, 19);
    const day = [midnight, midnight + 1, midnight + DAY - 1];
    const cutoffs = day.map((now) => retentionCutoff(now, RETENTION_DAYS));
    expect(new Set(cutoffs)).toEqual(new Set([CUTOFF]));
    expect(retentionCutoff(midnight + DAY, RETENTION_DAYS)).toBe(CUTOFF + DAY);
  });

  it("never leaves the window shorter than its days", () => {
    for (const now of [NOW, Date.UTC(2026, 10, 19), Date.UTC(2027, 1, 28, 23)])
      expect(now - retentionCutoff(now, RETENTION_DAYS)).toBeGreaterThanOrEqual(
        RETENTION_DAYS * DAY,
      );
  });
});

describe("retainedSnapshot at the window's edges", () => {
  it("keeps a flight from the flight cutoff on, by start or submission", () => {
    const kept = retainedFlights(
      flight("at-cutoff", FLIGHT_CUTOFF, { submittedAt: LONG_AGO }),
      flight("before", FLIGHT_CUTOFF - 1),
      flight("synced-late", FLIGHT_CUTOFF - DAY, {
        submittedAt: FLIGHT_CUTOFF,
      }),
      flight("older-than-90-days", CUTOFF - 30 * DAY),
    );
    expect(kept).toEqual(["at-cutoff", "synced-late", "older-than-90-days"]);
  });

  it("keeps a resolved report created, resolved or deferred from the cutoff on", () => {
    const kept = retainedReports(
      report("created", CUTOFF),
      report("before", CUTOFF - 1),
      report("resolved", LONG_AGO, { resolvedAt: CUTOFF }),
      report("resolved-before", LONG_AGO, { resolvedAt: CUTOFF - 1 }),
      report("deferred", LONG_AGO, { deferral: deferral(CUTOFF) }),
    );
    expect(kept).toEqual(["created", "resolved", "deferred"]);
  });

  it("keeps a closed work order opened, closed or revised from the cutoff on", () => {
    const orders = [
      order("opened", { status: "cancelled", recordedAt: CUTOFF }),
      order("opened-before", { status: "cancelled", recordedAt: CUTOFF - 1 }),
      completed("closed", "2024-01-10", { closeout: closeout(CUTOFF) }),
      completed("closed-before", "2024-01-10", {
        closeout: closeout(CUTOFF - 1),
      }),
      completed("completion-date", "2026-08-21"),
      completed("completion-date-before", "2026-08-20"),
      completed("revised", "2024-01-10", { revisions: [revision(CUTOFF)] }),
    ];
    expect(retainedOrders(withRecentWork(orders))).toEqual([
      "opened",
      "closed",
      "completion-date",
      "revised",
    ]);
  });

  it("keeps a closed work order whose job card or cost changed from the cutoff on", () => {
    const [carded, costed, idle] = ["carded", "costed", "idle"].map((n) =>
      completed(n, "2024-01-10"),
    );
    const s = snapshotOf({
      workOrders: withRecentWork([carded, costed, idle]),
      taskCards: [card("card", carded, { updatedAt: CUTOFF })],
      costs: [
        cost("cost", costed, CUTOFF),
        cost("idle-cost", idle, CUTOFF - 1),
      ],
    });
    expect(uuids(retainedSnapshot(s, NOW).workOrders)).toEqual(
      expect.arrayContaining([carded.uuid, costed.uuid]),
    );
    expect(uuids(retainedSnapshot(s, NOW).workOrders)).not.toContain(idle.uuid);
  });

  it("keeps budgets, the labor rate, templates and cards of no known order", () => {
    const template = card("template", undefined, { inspectionUuid: "i-1" });
    const orphan = card("orphan", order("not-loaded"));
    const s = snapshotOf({
      taskCards: [template, orphan],
      costs: [budget(), settings()],
    });
    const kept = retainedSnapshot(s, NOW);
    expect(uuids(kept.taskCards)).toEqual([template.uuid, orphan.uuid]);
    expect(uuids(kept.costs)).toEqual(["budget", "settings"]);
  });
});

describe("retainedSnapshot keeps open items however old", () => {
  it("keeps held flights, open and deferred reports, and open work orders", () => {
    const open = order("open", { status: "in-progress", recordedAt: LONG_AGO });
    const s = snapshotOf({
      flights: [flight("held", LONG_AGO, { status: "review" })],
      discrepancies: [
        report("open", LONG_AGO, { status: "open", resolvedAt: undefined }),
        report("deferred", LONG_AGO, {
          status: "open",
          resolvedAt: undefined,
          deferral: deferral(LONG_AGO),
        }),
      ],
      workOrders: [open],
      taskCards: [card("card", open, { updatedAt: LONG_AGO })],
      costs: [cost("cost", open, LONG_AGO)],
    });
    expect(retainedSnapshot(s, NOW)).toEqual(s);
  });

  it("keeps a closed work order that still has an open job card", () => {
    const stale = order("stale", { status: "cancelled", recordedAt: LONG_AGO });
    const s = snapshotOf({
      workOrders: [stale],
      taskCards: [
        card("ready", stale, { status: "ready", updatedAt: LONG_AGO }),
      ],
    });
    expect(retainedSnapshot(s, NOW)).toEqual(s);
  });
});

describe("retainedSnapshot keeps the latest completed work orders", () => {
  it("keeps the five latest completed on each aircraft, however old", () => {
    const dates = ["2020-01-01", "2020-02-01", "2020-03-01", "2020-04-01"];
    const orders = [...dates, "2020-05-01", "2020-06-01"].flatMap((date) => [
      completed(`a-${date}`, date),
      ...(dates.includes(date)
        ? [completed(`b-${date}`, date, { aircraftUuid: B })]
        : []),
    ]);
    const kept = retainedOrders(orders);
    expect(kept.filter((n) => n.startsWith("a-"))).toEqual(
      [
        "2020-02-01",
        "2020-03-01",
        "2020-04-01",
        "2020-05-01",
        "2020-06-01",
      ].map((d) => `a-${d}`),
    );
    expect(kept.filter((n) => n.startsWith("b-"))).toEqual(
      dates.map((d) => `b-${d}`),
    );
  });

  it("keeps every order tied with the fifth latest completion date", () => {
    const orders = ["one", "two", "three"].flatMap((n) => [
      completed(`${n}-old`, "2020-01-01"),
      completed(`${n}-new`, "2020-06-01"),
    ]);
    expect(retainedOrders(orders)).toHaveLength(orders.length);
  });

  it("does not count cancelled orders among the five", () => {
    const cancelled = ["c1", "c2", "c3", "c4", "c5"].map((n) =>
      order(n, {
        status: "cancelled",
        completionDate: "2020-12-01",
        recordedAt: LONG_AGO,
      }),
    );
    expect(
      retainedOrders([...cancelled, completed("done", "2020-01-01")]),
    ).toEqual(["done"]);
  });
});

describe("retainedSnapshot moves job cards and costs with their work order", () => {
  it("keeps or drops an order's job cards, archived job cards and cost with it", () => {
    const kept = completed("kept", "2020-06-01");
    const dropped = completed("dropped", "2020-01-01");
    const s = snapshotOf({
      workOrders: [...recentWork(5).slice(1), kept, dropped],
      taskCards: [card("kept-card", kept), card("dropped-card", dropped)],
      archivedTaskCards: [
        card("kept-archived", kept),
        card("dropped-archived", dropped),
      ],
      costs: [
        cost("kept-cost", kept, LONG_AGO),
        cost("dropped-cost", dropped, LONG_AGO),
      ],
    });
    const r = retainedSnapshot(s, NOW);
    expect(uuids(r.taskCards)).toEqual([uuidOf("kept-card")]);
    expect(uuids(r.archivedTaskCards)).toEqual([uuidOf("kept-archived")]);
    expect(uuids(r.costs)).toEqual(["kept-cost"]);
  });

  it("changes only the windowed collections and adds none a view lacks", () => {
    const s: Snapshot = {
      ...demoSnapshot(),
      flights: [flight("old", LONG_AGO)],
      discrepancies: [],
      taskCards: undefined,
      costs: undefined,
    };
    const r = retainedSnapshot(s, NOW);
    expect(r).toEqual({ ...s, flights: [] });
    expect([r.taskCards, r.costs]).toEqual([undefined, undefined]);
  });
});

describe("historyPage", () => {
  const s = history();
  const retained = retainedSnapshot(s, NOW);

  it.each([1, 3, 7, MAX_HISTORY_PAGE_SIZE])(
    "pages everything the workspace leaves out, once and in list order, %i at a time",
    (numItems) => {
      const pages = (["flights", "discrepancies", "workOrders"] as const).map(
        (kind) => allPages(s, { kind, cursor: null, numItems }).records,
      );
      const paged = merge(pages);
      for (const key of COLLECTIONS) {
        const all = uuids(s[key]);
        const kept = uuids(retained[key]);
        expect(
          uuids(paged[key]).filter((u) => kept.includes(u)),
          key,
        ).toEqual([]);
        expect([...kept, ...uuids(paged[key])].sort(), key).toEqual(
          [...all].sort(),
        );
      }
      expect(paged.flights.map((f) => [f.startTime, f.uuid])).toEqual(
        listOrder(paged.flights.map((f) => [f.startTime, f.uuid])),
      );
      expect(paged.discrepancies.map((d) => [d.createdAt, d.uuid])).toEqual(
        listOrder(paged.discrepancies.map((d) => [d.createdAt, d.uuid])),
      );
      expect(paged.workOrders.map((w) => [w.recordedAt, w.uuid])).toEqual(
        listOrder(paged.workOrders.map((w) => [w.recordedAt, w.uuid])),
      );
    },
  );

  it("pages only one aircraft's records, or one flight status, when asked", () => {
    const flights = allPages(s, {
      kind: "flights",
      aircraftUuid: B,
      status: "accepted",
      cursor: null,
      numItems: 4,
    }).records.flights;
    const kept = uuids(retained.flights);
    const expected = s.flights.filter(
      (f) =>
        f.aircraftUuid === B &&
        f.status === "accepted" &&
        !kept.includes(f.uuid),
    );
    expect(uuids(flights).sort()).toEqual(uuids(expected).sort());
    expect(flights.length).toBeGreaterThan(0);
  });

  it("continues after its cursor when newer records arrive between pages", () => {
    const request = {
      kind: "discrepancies",
      cursor: null,
      numItems: 5,
    } as const;
    const first = historyPage(s, request, NOW);
    const later = snapshotOf({
      ...s,
      discrepancies: [report("zz-newest", CUTOFF - 1), ...s.discrepancies],
    });
    const next = { ...request, cursor: first.continueCursor };
    expect(historyPage(later, next, NOW)).toEqual(historyPage(s, next, NOW));
  });

  it("is done on the page that takes the last older row", () => {
    const two = snapshotOf({
      flights: [flight("old-1", LONG_AGO), flight("old-2", LONG_AGO + 1)],
    });
    const page = (numItems: number) =>
      historyPage(two, { kind: "flights", cursor: null, numItems }, NOW);
    expect(page(2).isDone).toBe(true);
    expect(page(1).isDone).toBe(false);
  });

  it("bounds the page size and says when the last page is reached", () => {
    const one = historyPage(
      s,
      { kind: "flights", cursor: null, numItems: 0 },
      NOW,
    );
    const big = historyPage(
      s,
      { kind: "flights", cursor: null, numItems: 10_000 },
      NOW,
    );
    expect(one.records.flights).toHaveLength(1);
    expect(big.records.flights).toHaveLength(MAX_HISTORY_PAGE_SIZE);
    const end = allPages(s, { kind: "workOrders", cursor: null, numItems: 50 });
    const past = {
      kind: "workOrders",
      cursor: end.cursor,
      numItems: 50,
    } as const;
    expect(end.records.workOrders.length).toBeGreaterThan(0);
    expect(historyPage(s, past, NOW)).toEqual({
      records: emptyRecords(),
      isDone: true,
      continueCursor: end.cursor,
    });
  });

  it("refuses a cursor it did not write, or one from another list", () => {
    const flightCursor = historyPage(
      s,
      { kind: "flights", cursor: null, numItems: 1 },
      NOW,
    ).continueCursor;
    for (const cursor of [
      "",
      "12",
      "not json",
      '["x"]',
      "[1,2]",
      flightCursor!,
    ])
      expect(() =>
        historyPage(s, { kind: "discrepancies", cursor, numItems: 1 }, NOW),
      ).toThrow("Invalid history cursor.");
  });
});

// Follows the cursors to the last page; a cursor that stops advancing fails
// the test instead of looping.
function allPages(s: Snapshot, request: HistoryPageRequest) {
  const pages: HistoryRecords[] = [];
  let cursor = request.cursor;
  let done = false;
  while (!done) {
    if (pages.length > MAX_PAGES) throw new Error("Paging never finished.");
    const page = historyPage(s, { ...request, cursor }, NOW);
    pages.push(page.records);
    cursor = page.continueCursor;
    done = page.isDone;
  }
  return { records: merge(pages), cursor };
}

function merge(pages: HistoryRecords[]): HistoryRecords {
  return {
    flights: pages.flatMap((p) => p.flights),
    discrepancies: pages.flatMap((p) => p.discrepancies),
    workOrders: pages.flatMap((p) => p.workOrders),
    taskCards: pages.flatMap((p) => p.taskCards),
    archivedTaskCards: pages.flatMap((p) => p.archivedTaskCards),
    costs: pages.flatMap((p) => p.costs),
  };
}

// Newest first; equal keys by uuid, highest first.
function listOrder(rows: (string | number)[][]) {
  return [...rows].sort(([ak, au], [bk, bu]) =>
    ak !== bk ? (ak > bk ? -1 : 1) : au > bu ? -1 : au < bu ? 1 : 0,
  );
}

function emptyRecords(): HistoryRecords {
  return {
    flights: [],
    discrepancies: [],
    workOrders: [],
    taskCards: [],
    archivedTaskCards: [],
    costs: [],
  };
}

function snapshotOf(records: Partial<Snapshot>): Snapshot {
  return { ...demoSnapshot(), ...emptyRecords(), ...records };
}

function uuids(rows: { uuid: string }[] | undefined) {
  return (rows ?? []).map((r) => r.uuid);
}

function retainedFlights(...flights: Flight[]) {
  return uuids(retainedSnapshot(snapshotOf({ flights }), NOW).flights);
}

function retainedReports(...discrepancies: Discrepancy[]) {
  return uuids(
    retainedSnapshot(snapshotOf({ discrepancies }), NOW).discrepancies,
  );
}

// By number, leaving out the recent orders withRecentWork adds.
function retainedOrders(workOrders: WorkOrder[]) {
  const kept = retainedSnapshot(snapshotOf({ workOrders }), NOW).workOrders;
  return (kept ?? [])
    .map((w) => w.number)
    .filter((n) => !n.startsWith("recent-"));
}

// Five newer completed orders on the same aircraft, so an order is kept
// only by the window, not as one of the latest five.
function withRecentWork(orders: WorkOrder[]) {
  return [...recentWork(5), ...orders];
}

function recentWork(count: number) {
  return Array.from({ length: count }, (_, i) =>
    completed(`recent-${i}`, `2026-11-0${i + 1}`),
  );
}

function flight(
  uuid: string,
  start: number,
  overrides: Partial<Flight> = {},
): Flight {
  return {
    uuid,
    aircraftUuid: A,
    authorId: "pilot",
    pilotId: "pilot",
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
    ...overrides,
  };
}

function report(
  uuid: string,
  createdAt: number,
  overrides: Partial<Discrepancy> = {},
): Discrepancy {
  return {
    uuid,
    aircraftUuid: A,
    description: "Landing light flickers.",
    status: "resolved",
    authorId: "pilot",
    createdAt,
    resolvedAt: createdAt,
    ...overrides,
  };
}

function deferral(deferredAt: number): NonNullable<Discrepancy["deferral"]> {
  return {
    type: "mel",
    melItem: "33-1",
    category: "C",
    placard: "INOP",
    deferredOn: new Date(deferredAt).toISOString().slice(0, 10),
    deferredAt,
    deferredBy: "admin",
    deferredByName: "Administrator",
  };
}

// Work order uuids derive from their names, so a test can name the order it
// expects and the uuid stays valid.
function order(name: string, overrides: Partial<WorkOrder> = {}): WorkOrder {
  return workOrderSchema.parse({
    uuid: uuidOf(name),
    version: 1,
    number: name,
    aircraftUuid: A,
    dateOpened: "2024-01-01",
    supervisor: "Chief inspector",
    scope: "100-hour inspection.",
    priority: "routine",
    status: "open",
    completionDate: "",
    releaseOutcome: "",
    finalReview: "",
    recordedAt: LONG_AGO,
    createdBy: "admin",
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
    ...overrides,
  });
}

function completed(
  name: string,
  completionDate: string,
  overrides: Partial<WorkOrder> = {},
) {
  return order(name, { status: "completed", completionDate, ...overrides });
}

function closeout(recordedAt: number) {
  return closeoutSchema.parse({
    recordedAt,
    aircraft: {
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      cycles: 0,
      registration: "N1",
      make: "Cessna",
      model: "206",
      serial: "1",
    },
    completedBy: {
      userId: "admin",
      name: "Admin",
      licenseNumber: "",
      certificateType: "",
    },
    workPerformed: "",
    components: [],
    compliance: [],
  });
}

function revision(recordedAt: number) {
  return {
    number: 1,
    recordedAt,
    authorId: "admin",
    authorName: "Admin",
    reason: "Typo.",
    previousRecord: "{}",
  };
}

function card(
  name: string,
  w: WorkOrder | undefined,
  overrides: Partial<TaskCard> = {},
): TaskCard {
  return taskCardSchema.parse({
    ...taskCardDefaults(w?.aircraftUuid ?? A),
    uuid: uuidOf(name),
    version: 1,
    createdBy: "admin",
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    cardNumber: name,
    title: "Inspect the engine compartment",
    workOrderUuid: w?.uuid ?? "",
    status: "completed",
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
    ...overrides,
  });
}

function cost(uuid: string, w: WorkOrder, createdAt: number): CostRecord {
  return costRecordSchema.parse({
    uuid,
    version: 1,
    programUuid: "demo-program",
    kind: "workOrder",
    aircraftUuid: w.aircraftUuid,
    workOrderUuid: w.uuid,
    labor: [
      {
        uuid: `${uuid}-labor`,
        date: "2024-01-10",
        technician: "Mechanic",
        minutes: 60,
        createdBy: "admin",
        createdAt,
      },
    ],
    other: [],
    partUnitCosts: [],
  });
}

function budget(): CostRecord {
  return costRecordSchema.parse({
    uuid: "budget",
    version: 1,
    programUuid: "demo-program",
    kind: "budget",
    aircraftUuid: A,
    year: 2024,
    amountCents: 100_000,
  });
}

function settings(): CostRecord {
  return costRecordSchema.parse({
    uuid: "settings",
    version: 1,
    programUuid: "demo-program",
    kind: "settings",
    laborRateCents: 9500,
  });
}

function uuidOf(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-8000-${hash.toString(16).padStart(12, "0")}`;
}

// Two years of records on two aircraft, from a fixed seed, with records that
// share a start time, report time or opening time so ties cross pages.
function history(): Snapshot {
  let seed = 7;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
  const at = () => NOW - (next() % 730) * DAY - (next() % DAY);
  const s = snapshotOf({});
  for (let i = 0; i < 400; i++) {
    const start = i % 9 === 0 ? FLIGHT_CUTOFF - 40 * DAY : at();
    s.flights.push(
      flight(`f-${String(i).padStart(3, "0")}`, start, {
        aircraftUuid: i % 2 ? B : A,
        status: (["accepted", "accepted", "rejected", "review"] as const)[
          Math.floor(i / 2) % 4
        ],
        submittedAt: start,
      }),
    );
  }
  for (let i = 0; i < 60; i++) {
    const created = i % 7 === 0 ? CUTOFF - 10 * DAY : at();
    s.discrepancies.push(
      report(`d-${String(i).padStart(3, "0")}`, created, {
        aircraftUuid: i % 2 ? B : A,
        ...(i % 5 === 0 ? { status: "open", resolvedAt: undefined } : {}),
      }),
    );
  }
  addWork(s, next, at);
  return s;
}

function addWork(s: Snapshot, next: () => number, at: () => number) {
  for (let i = 0; i < 40; i++) {
    const opened = i % 6 === 0 ? CUTOFF - 20 * DAY : at();
    const w = completed(
      `w-${i}`,
      new Date(opened + DAY).toISOString().slice(0, 10),
      {
        aircraftUuid: i % 2 ? B : A,
        recordedAt: opened,
        ...(i % 8 === 0 ? { status: "in-progress", completionDate: "" } : {}),
      },
    );
    s.workOrders!.push(w);
    s.costs!.push(cost(`c-${i}`, w, opened));
    for (let j = 0; j < next() % 4; j++)
      s.taskCards!.push(card(`w-${i}-card-${j}`, w, { updatedAt: opened }));
    if (i % 3 === 0) s.archivedTaskCards!.push(card(`w-${i}-archived`, w));
  }
  s.taskCards!.push(card("template", undefined, { inspectionUuid: "i-1" }));
  s.costs!.push(settings());
}
