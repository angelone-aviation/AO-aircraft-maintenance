/**
 * Responsibility: Pins the purchasing window (H5): which parts requests,
 *   purchase orders and flight plans the workspace keeps and why, what a
 *   non-administrator still sees of the orders, and that the history pages
 *   hold exactly what the window leaves out, with what follows each row.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain (retention, purchasingWindow, programs,
 *   workOrders, taskCards, purchaseOrders), src/data/demo.ts (seed),
 *   tests/fixtures/purchasingEdges.ts (one edge per rule).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  MAX_HISTORY_PAGE_SIZE,
  historyPage,
  retainedSnapshot,
  workspaceWindow,
  type HistoryPageRequest,
  type HistoryRecords,
} from "./retention";
import {
  isKeptPlan,
  isOpenPurchaseOrder,
  requestSettledAt,
} from "./purchasingWindow";
import { scopedSnapshot } from "./programs";
import { workOrderSchema } from "./workOrders";
import { taskCardDefaults, taskCardSchema } from "./taskCards";
import type { Snapshot } from "./model";
import {
  EDGES,
  edgeLabel,
  edgeRecords,
  type EdgeAnchors,
} from "../../tests/fixtures/purchasingEdges";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 15, 30);
const MAX_PAGES = 100;
const ORDER = "11111111-1111-4111-8111-000000000001";
const CARD = "11111111-1111-4111-8111-000000000002";
const LISTS = ["requests", "orders", "plans"] as const;

type List = (typeof LISTS)[number];

describe("retainedSnapshot keeps purchasing by its rules", () => {
  it("keeps each edge its rule keeps, and no other", () => {
    const kept = labels(retainedSnapshot(edges(), NOW));
    for (const list of LISTS) {
      for (const label of EDGES.kept[list])
        expect(kept[list], `${list} ${label}`).toContain(label);
      for (const label of EDGES.paged[list])
        expect(kept[list], `${list} ${label}`).not.toContain(label);
    }
  });

  it("keeps an order's allocations with the requests they count toward", () => {
    const s = scopedSnapshot(edges());
    const kept = retainedSnapshot(s, NOW);
    const requests = new Set((kept.partsRequests ?? []).map((r) => r.uuid));
    const purchases = kept.partsRequestPurchases ?? [];
    expect(purchases.length).toBeGreaterThan(0);
    expect(purchases.every((a) => requests.has(a.requestUuid))).toBe(true);
    expect(purchases).toEqual(
      (s.partsRequestPurchases ?? []).filter((a) =>
        requests.has(a.requestUuid),
      ),
    );
  });
});

describe("workspaceWindow for someone who sees no orders", () => {
  it("keeps the purchases and parts on order the orders give their requests", () => {
    const full = asMechanic(edges());
    const view = workspaceWindow(full, NOW);
    const whole = scopedSnapshot(full);
    expect(view.purchaseOrders).toEqual([]);
    expect(view.partsOnOrder).toEqual(whole.partsOnOrder);
    const kept = new Set((view.partsRequests ?? []).map((r) => r.uuid));
    expect(view.partsRequestPurchases).toEqual(
      (whole.partsRequestPurchases ?? []).filter((a) =>
        kept.has(a.requestUuid),
      ),
    );
    const partly = (view.partsRequests ?? []).find(
      (r) => edgeLabel(r.number) === "PARTLY",
    )!;
    const received = (view.partsRequestPurchases ?? [])
      .filter((a) => a.requestUuid === partly.uuid)
      .reduce((n, a) => n + a.received, 0);
    expect(received).toBe(2);
  });
});

describe("historyPage over purchasing", () => {
  const s = scopedSnapshot(edges());
  const kept = retainedSnapshot(s, NOW);

  it.each([1, 2, MAX_HISTORY_PAGE_SIZE])(
    "pages every request, order and plan the window leaves out once, at %i a page",
    (numItems) => {
      const pages = {
        requests: allPages(s, { kind: "partsRequests", ...first(numItems) }),
        orders: allPages(s, { kind: "purchaseOrders", ...first(numItems) }),
        plans: allPages(s, { kind: "flightPlans", ...first(numItems) }),
      };
      const sides = [
        ["partsRequests", "requests"],
        ["purchaseOrders", "orders"],
        ["flightPlans", "plans"],
      ] as const;
      for (const [key, list] of sides) {
        const paged = pages[list][key].map((r) => r.uuid);
        const all = [...(kept[key] ?? []), ...pages[list][key]];
        expect(new Set(paged).size, list).toBe(paged.length);
        expect(all.map((r) => r.uuid).sort(), list).toEqual(
          (s[key] ?? []).map((r) => r.uuid).sort(),
        );
      }
    },
  );

  it("brings a request's allocations and a plan's flights with it", () => {
    const requests = allPages(s, { kind: "partsRequests", ...first(50) });
    const repair = requests.partsRequests.find(
      (r) => edgeLabel(r.number) === "REPAIR",
    )!;
    expect(
      requests.partsRequestPurchases.map((a) => [a.requestUuid, a.received]),
    ).toEqual([[repair.uuid, 1]]);
    const plans = allPages(s, { kind: "flightPlans", ...first(50) });
    expect(plans.flightPlans.map((p) => p.sourceName)).toEqual(["CANCELLED"]);
    expect(plans.flights).toEqual([]);
  });

  it("narrows requests to a record's list, and orders to a vendor", () => {
    const repair = (s.partsRequests ?? []).find(
      (r) => edgeLabel(r.number) === "REPAIR",
    )!;
    const listed = allPages(s, {
      kind: "partsRequests",
      source: repair.source,
      ...first(50),
    });
    expect(listed.partsRequests.map((r) => r.uuid)).toEqual([repair.uuid]);
    const elsewhere = allPages(s, {
      kind: "purchaseOrders",
      vendor: "Nobody Supply",
      ...first(50),
    });
    expect(elsewhere.purchaseOrders).toEqual([]);
    const ours = allPages(s, {
      kind: "purchaseOrders",
      vendor: "  example AVIATION supply ",
      ...first(50),
    });
    expect(ours.purchaseOrders.length).toBeGreaterThan(0);
  });

  it("leaves a mechanic's order pages empty, as their workspace holds none", () => {
    const mechanic = scopedSnapshot(asMechanic(edges()));
    const page = historyPage(
      mechanic,
      { kind: "purchaseOrders", ...first(50) },
      NOW,
    );
    expect(page.records.purchaseOrders).toEqual([]);
    expect(page.isDone).toBe(true);
  });
});

describe("the rules' edges", () => {
  const { purchaseOrders, partsRequests, flightPlans } = edgeRecords(
    anchors(),
    counter(),
  );
  const closed = purchaseOrders.find((p) => p.phase === "closed")!;

  it("calls an order open while a repair is out or a core is owed", () => {
    expect(isOpenPurchaseOrder(closed)).toBe(false);
    const out = {
      ...closed,
      shipments: [
        {
          uuid: "ship",
          date: "2026-01-01",
          carrier: "UPS",
          tracking: "1Z",
          lines: [{ lineUuid: closed.lines[0].uuid, quantity: 3 }],
        },
      ],
    };
    expect(isOpenPurchaseOrder(out)).toBe(true);
  });

  it("settles a request only when its own record shows it closed", () => {
    const open = partsRequests.find((r) => edgeLabel(r.number) === "OPEN")!;
    expect(requestSettledAt(open)).toBeUndefined();
    expect(requestSettledAt({ ...open, cancelled: true })).toBe(open.createdAt);
  });

  it("keeps a plan departing on the flight cutoff's day, not the day before", () => {
    const [plan] = flightPlans;
    const cutoffs = { closed: NOW, flights: Date.UTC(2026, 4, 20) };
    const departing = (at: number) => ({
      ...plan,
      createdAt: 0,
      departureAt: new Date(at).toISOString(),
    });
    const none = new Set<string>();
    expect(isKeptPlan(departing(cutoffs.flights), none, cutoffs)).toBe(true);
    expect(isKeptPlan(departing(cutoffs.flights - 1), none, cutoffs)).toBe(
      false,
    );
  });
});

// The demo program with one aircraft's edges, its open work order and the
// job card the CARD edge names.
function edges(): Snapshot {
  const demo = demoSnapshot();
  const a = anchors();
  const records = edgeRecords(a, counter());
  return {
    ...demo,
    flights: records.flights,
    discrepancies: [],
    workOrders: [openOrder(a.aircraft.uuid)],
    taskCards: [
      taskCardSchema.parse({
        ...taskCardDefaults(a.aircraft.uuid),
        uuid: CARD,
        version: 1,
        createdBy: "demo-admin",
        createdAt: NOW - 300 * DAY,
        updatedAt: NOW - 300 * DAY,
        cardNumber: "JC-EDGE",
        title: "Remove the engine",
        workOrderUuid: ORDER,
        status: "completed",
        technicianSignoff: null,
        inspectionSignoff: null,
        stepSignoffs: {},
      }),
    ],
    archivedTaskCards: [],
    costs: [],
    partsRequests: records.partsRequests,
    purchaseOrders: records.purchaseOrders,
    flightPlans: records.flightPlans,
  };
}

function anchors(): EdgeAnchors {
  const demo = demoSnapshot();
  const aircraft = demo.aircraft[0];
  return {
    end: NOW,
    program: aircraft.programUuid!,
    admin: demo.user.id,
    pilot: "demo-pilot",
    aircraft: { ...aircraft, model: aircraft.model },
    order: { uuid: ORDER, card: CARD },
    component: "component-1",
    inspection: demo.inspections[0].uuid,
    stock: { uuid: "stock-1", locationUuid: "location-1", partNumber: "F-1" },
    stockRequest: true,
  };
}

// Opened before the edges and still open, so the window keeps it.
function openOrder(aircraftUuid: string) {
  return workOrderSchema.parse({
    uuid: ORDER,
    version: 1,
    number: "WO-EDGE",
    aircraftUuid,
    dateOpened: "2025-12-01",
    supervisor: "Chief inspector",
    scope: "Engine change.",
    priority: "routine",
    status: "in-progress",
    completionDate: "",
    releaseOutcome: "",
    recordedAt: NOW - 400 * DAY,
    createdBy: "demo-admin",
    aircraft: {
      registration: "N206",
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

// Read and maintenance on the edges' aircraft, without inventory: no orders.
function asMechanic(s: Snapshot): Snapshot {
  const group = {
    id: "mechanics",
    name: "Mechanics",
    programUuid: s.aircraft[0].programUuid,
    aircraftIds: [s.aircraft[0].uuid],
    permissions: ["read" as const, "maintenance" as const],
  };
  const user = { ...s.members[1], id: "demo-pilot", groupIds: [group.id] };
  return { ...s, user, groups: [...s.groups, group] };
}

function labels(s: Snapshot): Record<List, string[]> {
  return {
    requests: (s.partsRequests ?? []).map((r) => edgeLabel(r.number)),
    orders: (s.purchaseOrders ?? []).map((p) => edgeLabel(p.number)),
    plans: (s.flightPlans ?? []).map((p) => edgeLabel(p.sourceName)),
  };
}

function first(numItems: number) {
  return { cursor: null, numItems };
}

function allPages(s: Snapshot, request: HistoryPageRequest): HistoryRecords {
  const pages: HistoryRecords[] = [];
  let next = request;
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = historyPage(s, next, NOW);
    pages.push(page.records);
    if (page.isDone) return merge(pages);
    next = { ...next, cursor: page.continueCursor };
  }
  throw new Error("Paging never finished.");
}

function merge(pages: HistoryRecords[]): HistoryRecords {
  const [head, ...rest] = pages;
  const merged = { ...head };
  for (const page of rest)
    for (const key of Object.keys(merged) as (keyof HistoryRecords)[])
      Object.assign(merged, { [key]: [...merged[key], ...page[key]] });
  return merged;
}

function counter() {
  let next = 0;
  return () =>
    `22222222-2222-4222-8222-${(next++).toString(16).padStart(12, "0")}`;
}
