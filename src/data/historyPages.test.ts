/**
 * Responsibility: Pins how a screen's older history loads and merges: the
 *   snapshot's copy wins, pages follow their cursors, a write of the list's
 *   kind reloads them, a program switch drops them, and offline nothing
 *   loads.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/historyPages.ts, src/data/demo.ts (seed),
 *   src/domain (retention, model, partsRequests types).
 */
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo";
import {
  HistoryPager,
  historyScope,
  historyWriteMark,
  loadHistoryPages,
  NO_HISTORY,
  withHistory,
  type FetchHistoryPage,
  type HistoryList,
} from "./historyPages";
import {
  emptyHistoryRecords,
  type HistoryPage,
  type HistoryPageRequest,
} from "../domain/retention";
import type { AuditEntry, Flight, Member, Snapshot } from "../domain/model";
import type { RequestPurchase } from "../domain/partsRequests";

const FLIGHTS: HistoryList = { kind: "flights" };
const ROWS_PER_PAGE = 2;

describe("withHistory", () => {
  it("adds page rows after the snapshot's, and the snapshot's copy wins", () => {
    const s = snapshot({ flights: [flight("a", "kept")] });
    const merged = withHistory(s, {
      flights: [flight("a", "stale page copy"), flight("b"), flight("b")],
      members: [member("old-pilot"), member(s.user.id, "Renamed")],
    });
    expect(merged.flights.map((f) => [f.uuid, f.remarks])).toEqual([
      ["a", "kept"],
      ["b", ""],
    ]);
    expect(merged.members.at(-1)?.id).toBe("old-pilot");
    expect(merged.members.find((m) => m.id === s.user.id)?.name).not.toBe(
      "Renamed",
    );
  });

  it("merges a work order's files and leaves absent collections absent", () => {
    const s = snapshot({ workOrderAttachments: undefined, taskEvidence: [] });
    const file = {
      uuid: "file",
      workOrderUuid: "wo",
      name: "337.pdf",
      size: 1,
      uploadedAt: 0,
    };
    const merged = withHistory(s, { workOrderAttachments: [file] });
    expect(merged.workOrderAttachments).toEqual([file]);
    expect(withHistory(s, {}).workOrderAttachments).toBeUndefined();
    expect(withHistory(s, {})).toEqual(s);
  });

  // An allocation has no uuid: its order, line and request name it.
  it("joins a request's purchases once, the snapshot's copy winning", () => {
    const held = purchase("po-1", "request-1", 1);
    const s = snapshot({ partsRequestPurchases: [held] });
    const merged = withHistory(s, {
      partsRequestPurchases: [
        { ...held, received: 0 },
        purchase("po-2", "request-1", 2),
      ],
    });
    expect(merged.partsRequestPurchases).toEqual([
      held,
      purchase("po-2", "request-1", 2),
    ]);
  });
});

describe("loadHistoryPages", () => {
  it("follows the cursors for as many pages as asked, appending to a start", async () => {
    const server = pagedServer(["f1", "f2", "f3", "f4", "f5"]);
    const two = await loadHistoryPages(server.fetch, FLIGHTS, NO_HISTORY, 2);
    expect(uuids(two)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(two).toMatchObject({ pages: 2, isDone: false, cursor: "4" });
    const rest = await loadHistoryPages(server.fetch, FLIGHTS, two, 5);
    expect(uuids(rest)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(rest).toMatchObject({ pages: 3, isDone: true });
    expect(server.cursors()).toEqual([null, "2", "4"]);
  });

  it("asks only for the list's filters, and status only for flights", async () => {
    const fetch = vi.fn<FetchHistoryPage>(async () => page([], true));
    await loadHistoryPages(
      fetch,
      { kind: "flights", aircraftUuid: "a", status: "review" },
      NO_HISTORY,
      1,
    );
    await loadHistoryPages(
      fetch,
      { kind: "workOrders", aircraftUuid: "a", status: "review" },
      NO_HISTORY,
      1,
    );
    expect(fetch.mock.calls.map(([request]) => request)).toEqual([
      {
        kind: "flights",
        aircraftUuid: "a",
        status: "review",
        cursor: null,
        numItems: 50,
      },
      { kind: "workOrders", aircraftUuid: "a", cursor: null, numItems: 50 },
    ]);
  });

  it("asks requests by record and orders by vendor, never orders by aircraft", async () => {
    const fetch = vi.fn<FetchHistoryPage>(async () => page([], true));
    const source = { kind: "stock", uuid: "s", workOrderUuid: "" } as const;
    for (const list of [
      { kind: "partsRequests", source, vendor: "V" },
      { kind: "purchaseOrders", aircraftUuid: "a", vendor: "V", source },
    ] as const)
      await loadHistoryPages(fetch, list, NO_HISTORY, 1);
    expect(fetch.mock.calls.map(([request]) => request)).toEqual([
      { kind: "partsRequests", source, cursor: null, numItems: 50 },
      { kind: "purchaseOrders", vendor: "V", cursor: null, numItems: 50 },
    ]);
  });
});

describe("historyWriteMark and historyScope", () => {
  it("marks the newest change-log entry of the list's kind", () => {
    const s = snapshot({
      syncedAt: Date.UTC(2026, 10, 19, 15),
      audit: [
        entry("cost", "cost.labor.add"),
        entry("report", "discrepancy.resolved"),
        entry("card", "taskCard.save"),
        entry("flight", "flight.save"),
      ],
    });
    const day = `${Date.UTC(2026, 10, 19)} `;
    expect(historyWriteMark(s, "flights")).toBe(`${day}flight`);
    expect(historyWriteMark(s, "discrepancies")).toBe(`${day}report`);
    expect(historyWriteMark(s, "workOrders")).toBe(`${day}cost`);
    expect(historyWriteMark({ ...s, audit: [] }, "flights")).toBe(day);
    expect(historyWriteMark(null, "flights")).toBeUndefined();
  });

  // A snapshot cut after midnight has a window a day shorter, so pages loaded
  // before it reload rather than leave out what it dropped.
  it("changes when the snapshot's window is cut on a later UTC day", () => {
    const at = (syncedAt: number) =>
      historyWriteMark(snapshot({ audit: [], syncedAt }), "flights");
    const midnight = Date.UTC(2026, 10, 20);
    expect(at(midnight - 60_000)).toBe(at(Date.UTC(2026, 10, 19)));
    expect(at(midnight)).not.toBe(at(midnight - 1));
  });

  it("names a different scope for another program, user or filter", () => {
    const s = snapshot({});
    const scopes = [
      historyScope(s, FLIGHTS),
      historyScope({ ...s, activeProgramUuid: "other" }, FLIGHTS),
      historyScope({ ...s, user: { ...s.user, id: "other" } }, FLIGHTS),
      historyScope(s, { kind: "flights", aircraftUuid: "a" }),
      historyScope(s, { kind: "flights", status: "review" }),
      historyScope(null, FLIGHTS),
      historyScope(s, { kind: "partsRequests" }),
      historyScope(s, {
        kind: "partsRequests",
        source: { kind: "stock", uuid: "s", workOrderUuid: "" },
      }),
      historyScope(s, { kind: "purchaseOrders" }),
      historyScope(s, { kind: "purchaseOrders", vendor: "V" }),
      historyScope(s, { kind: "flightPlans" }),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("reloads requests after an order's write, and plans after a flight's", () => {
    const s = snapshot({
      syncedAt: Date.UTC(2026, 10, 19, 15),
      audit: [entry("order", "po.receive"), entry("flight", "flight.save")],
    });
    const day = `${Date.UTC(2026, 10, 19)} `;
    expect(historyWriteMark(s, "partsRequests")).toBe(`${day}order`);
    expect(historyWriteMark(s, "purchaseOrders")).toBe(`${day}order`);
    expect(historyWriteMark(s, "flightPlans")).toBe(`${day}flight`);
  });
});

describe("HistoryPager", () => {
  it("loads older pages one at a time until the list is done", async () => {
    const server = pagedServer(["f1", "f2", "f3"]);
    const pager = connected(server);
    await loaded(pager);
    expect(uuids(pager.getState().loaded)).toEqual(["f1", "f2"]);
    await loaded(pager);
    expect(pager.getState().loaded).toMatchObject({ pages: 2, isDone: true });
    pager.loadOlder();
    expect(server.cursors()).toEqual([null, "2"]);
  });

  it("loads nothing offline", () => {
    const server = pagedServer(["f1"]);
    const pager = new HistoryPager(FLIGHTS, server.fetch);
    pager.sync({ scope: "program", mark: "m1", live: false });
    pager.loadOlder();
    expect(server.fetch).not.toHaveBeenCalled();
    expect(pager.getState().loading).toBe(false);
  });

  it("reloads every loaded page after a write of its kind", async () => {
    const server = pagedServer(["f1", "f2", "f3", "f4", "f5"]);
    const pager = connected(server);
    await loaded(pager);
    await loaded(pager);
    server.rows[0] = flight("f1", "corrected");
    pager.sync({ scope: "program", mark: "m2", live: true });
    await settled(pager);
    expect(server.cursors()).toEqual([null, "2", null, "2"]);
    const { loaded: reloaded, mark } = pager.getState();
    expect(reloaded.records.flights[0].remarks).toBe("corrected");
    expect(reloaded).toMatchObject({ pages: 2, cursor: "4" });
    expect(mark).toBe("m2");
  });

  it("needs no reload while nothing older is loaded", () => {
    const server = pagedServer(["f1"]);
    const pager = connected(server);
    pager.sync({ scope: "program", mark: "m2", live: true });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("reloads after a write made offline once the connection returns", async () => {
    const server = pagedServer(["f1", "f2", "f3"]);
    const pager = connected(server);
    await loaded(pager);
    pager.sync({ scope: "program", mark: "m2", live: false });
    expect(server.cursors()).toEqual([null]);
    pager.sync({ scope: "program", mark: "m2", live: true });
    await settled(pager);
    expect(server.cursors()).toEqual([null, null]);
  });

  it("drops loaded pages, and a page still loading, on a program switch", async () => {
    const server = pagedServer(["f1", "f2", "f3"]);
    const pager = connected(server);
    await loaded(pager);
    pager.loadOlder();
    pager.sync({ scope: "other program", mark: "m1", live: true });
    await settled(pager);
    expect(pager.getState()).toMatchObject({
      scope: "other program",
      loaded: NO_HISTORY,
      loading: false,
    });
  });

  it("keeps the pages and shows the error when a page fails", async () => {
    const server = pagedServer(["f1", "f2", "f3"]);
    const pager = connected(server);
    await loaded(pager);
    server.fetch.mockRejectedValueOnce(new Error("History not found."));
    await loaded(pager);
    expect(pager.getState()).toMatchObject({
      error: "History not found.",
      loading: false,
    });
    expect(uuids(pager.getState().loaded)).toEqual(["f1", "f2"]);
  });
});

function connected(server: ReturnType<typeof pagedServer>) {
  const pager = new HistoryPager(FLIGHTS, server.fetch);
  pager.sync({ scope: "program", mark: "m1", live: true });
  return pager;
}

async function loaded(pager: HistoryPager) {
  pager.loadOlder();
  await settled(pager);
}

// Waits until no request is in flight; the fake server answers at once.
async function settled(pager: HistoryPager) {
  for (let turn = 0; turn < 20 && pager.getState().loading; turn++)
    await Promise.resolve();
  await Promise.resolve();
}

// Serves its rows two at a time, the cursor being the next row's index.
function pagedServer(ids: string[]) {
  const rows = ids.map((id) => flight(id));
  const fetch = vi.fn(async (request: HistoryPageRequest) => {
    const start = request.cursor === null ? 0 : Number(request.cursor);
    const end = start + ROWS_PER_PAGE;
    return {
      ...page(rows.slice(start, end), end >= rows.length),
      continueCursor: String(end),
    };
  });
  const cursors = () => fetch.mock.calls.map(([request]) => request.cursor);
  return { rows, fetch, cursors };
}

function page(flights: Flight[], isDone: boolean): HistoryPage {
  return {
    records: { ...emptyHistoryRecords(), flights },
    members: [],
    isDone,
    continueCursor: null,
  };
}

function uuids(loaded: { records: { flights: Flight[] } }) {
  return loaded.records.flights.map((f) => f.uuid);
}

function snapshot(overrides: Partial<Snapshot>): Snapshot {
  return { ...demoSnapshot(), ...overrides };
}

function member(id: string, name = "Former pilot"): Member {
  return { ...demoSnapshot().members[0], id, name };
}

function entry(uuid: string, action: string): AuditEntry {
  return { uuid, at: 0, actorId: "demo-admin", action, entityUuid: uuid };
}

function flight(uuid: string, remarks = ""): Flight {
  return {
    uuid,
    aircraftUuid: "demo-206",
    authorId: "demo-admin",
    pilotId: "demo-admin",
    submittedAt: 0,
    status: "accepted",
    startTime: "2025-01-01T12:00:00Z",
    landings: 1,
    cycles: 0,
    origin: "KSEA",
    destination: "KBFI",
    operation: "Mission",
    flightRules: "VFR",
    remarks,
    discrepancy: "",
  };
}

function purchase(
  poUuid: string,
  requestUuid: string,
  received: number,
): RequestPurchase {
  return {
    requestUuid,
    lineUuid: "line",
    poUuid,
    number: poUuid.toUpperCase(),
    phase: "closed",
    quantity: 2,
    received,
    shipped: 0,
    expectedDate: "",
    purchasedDate: "",
    purchasedBy: "",
  };
}
