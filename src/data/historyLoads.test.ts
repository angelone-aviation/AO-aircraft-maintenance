/**
 * Responsibility: Pins the whole-history loads: an aircraft's lists read to
 *   the end with older work orders' files, named work orders, flights over a
 *   span split when too long, and closed work orders back to a date.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/historyLoads.ts, src/data/demo.ts (seed),
 *   src/domain (retention, historyReads, rejection, model).
 */
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "./demo";
import {
  loadAircraftHistory,
  loadFlightsBetween,
  loadMonthHistory,
  loadWorkOrders,
  loadWorkOrdersSince,
  type HistoryReads,
} from "./historyLoads";
import {
  emptyHistoryRecords,
  historyPage,
  type HistoryPageRequest,
} from "../domain/retention";
import {
  FLIGHT_RANGE_TOO_LONG,
  flightRange,
  workOrderHistory,
} from "../domain/historyReads";
import { Rejection } from "../domain/rejection";
import type { Flight, Snapshot } from "../domain/model";
import { workOrderSchema, type WorkOrder } from "../domain/workOrders";

const NOW = Date.UTC(2026, 10, 20, 12);
const DAY = 86_400_000;
const AIRCRAFT = "demo-206";

describe("loadAircraftHistory", () => {
  it("joins every older flight, report and work order, with older orders' files", async () => {
    const full = fleet();
    const reads = serverOver(full);
    const workspace = windowOf(full);
    const progress = vi.fn();
    const { snapshot, complete } = await loadAircraftHistory(
      reads,
      workspace,
      AIRCRAFT,
      progress,
    );
    expect(complete).toBe(true);
    expect(uuids(snapshot.flights)).toContain("old-flight");
    expect(uuids(snapshot.workOrders)).toContain("old-order");
    expect(uuids(snapshot.workOrderAttachments)).toEqual(["old-file"]);
    expect(progress).toHaveBeenLastCalledWith(2);
    expect(reads.workOrderHistory).toHaveBeenCalledExactlyOnceWith("old-order");
  });
});

describe("loadWorkOrders", () => {
  it("asks once for each named order the snapshot lacks, leaving out refused ones", async () => {
    const full = fleet();
    const reads = serverOver(full);
    const workspace = windowOf(full);
    const s = await loadWorkOrders(reads, workspace, [
      "old-order",
      "old-order",
      "recent-1",
      undefined,
      "missing",
    ]);
    expect(reads.workOrderHistory.mock.calls).toEqual([
      ["old-order"],
      ["missing"],
    ]);
    expect(uuids(s.workOrders).at(-1)).toBe("old-order");
    expect(s.workOrders).toHaveLength(6);
  });

  it("passes on any other failure", async () => {
    const reads = {
      workOrderHistory: vi.fn(async () => {
        throw new Error("Network down");
      }),
    };
    await expect(loadWorkOrders(reads, fleet(), ["x"])).rejects.toThrow(
      "Network down",
    );
  });
});

describe("loadFlightsBetween", () => {
  it("asks for a span too long in halves, newest first", async () => {
    const full = fleet();
    const reads = serverOver(full);
    reads.flightsInRange.mockRejectedValueOnce(
      new Rejection(FLIGHT_RANGE_TOO_LONG),
    );
    const from = NOW - 800 * DAY;
    const range = await loadFlightsBetween(reads, AIRCRAFT, from, NOW);
    expect(uuids(range.flights)).toEqual(["recent-flight", "old-flight"]);
    expect(reads.flightsInRange).toHaveBeenCalledTimes(3);
  });

  it("does not split a short span", async () => {
    const reads = serverOver(fleet());
    reads.flightsInRange.mockRejectedValue(
      new Rejection(FLIGHT_RANGE_TOO_LONG),
    );
    await expect(
      loadFlightsBetween(reads, AIRCRAFT, NOW - 1000, NOW),
    ).rejects.toThrow(FLIGHT_RANGE_TOO_LONG);
    expect(reads.flightsInRange).toHaveBeenCalledOnce();
  });
});

describe("loadWorkOrdersSince", () => {
  it("stops at the first page reaching back before the date", async () => {
    const full = fleet();
    const reads = serverOver(full);
    const s = await loadWorkOrdersSince(
      reads,
      windowOf(full),
      AIRCRAFT,
      "2020-01-01",
    );
    expect(uuids(s.workOrders)).toContain("old-order");
    expect(reads.historyPage).toHaveBeenCalledOnce();
  });
});

describe("loadMonthHistory", () => {
  it("joins the month's flights by local dates and its completed work orders", async () => {
    const full = fleet();
    const reads = serverOver(full);
    const s = await loadMonthHistory(
      reads,
      windowOf(full),
      AIRCRAFT,
      "2024-12",
    );
    expect(reads.flightsInRange).toHaveBeenCalledExactlyOnceWith({
      aircraftUuid: AIRCRAFT,
      from: new Date(2024, 11, 1).getTime(),
      to: new Date(2025, 0, 1).getTime(),
    });
    expect(uuids(s.flights)).toContain("old-flight");
    expect(reads.historyPage).toHaveBeenCalledOnce();
  });
});

// A server answering as the S5 queries do, over a full snapshot.
function serverOver(full: Snapshot) {
  return {
    historyPage: vi.fn(async (request: HistoryPageRequest) =>
      historyPage(full, request, NOW),
    ),
    workOrderHistory: vi.fn(async (uuid: string) =>
      workOrderHistory(full, uuid),
    ),
    flightsInRange: vi.fn<HistoryReads["flightsInRange"]>(async (request) =>
      flightRange(full, request),
    ),
  };
}

// The workspace: the full snapshot without the older records.
function windowOf(full: Snapshot): Snapshot {
  return {
    ...full,
    flights: full.flights.filter((f) => !f.uuid.startsWith("old")),
    discrepancies: [],
    workOrders: (full.workOrders ?? []).filter((w) => w.uuid !== "old-order"),
    workOrderAttachments: [],
  };
}

function fleet(): Snapshot {
  const demo = demoSnapshot();
  // Named rather than random uuids, so the tests read; the schema wants a
  // real one, replaced after parsing.
  const order = (uuid: string, completionDate: string): WorkOrder => ({
    ...workOrderSchema.parse({
      uuid: crypto.randomUUID(),
      version: 1,
      number: uuid,
      aircraftUuid: AIRCRAFT,
      dateOpened: completionDate,
      supervisor: "Chief inspector",
      scope: "Annual inspection.",
      priority: "routine",
      status: "completed",
      completionDate,
      releaseOutcome: "",
      recordedAt: Date.parse(completionDate),
      createdBy: "demo-admin",
      aircraft: {
        ...{ registration: "N206MA", make: "Cessna", model: "206" },
        ...{ serial: "1", totalSeconds: 0, hobbs: 0, tach: 0 },
        ...{ meter: "hobbs", cycles: 0 },
      },
      componentReadings: [],
      tasks: [],
    }),
    uuid,
  });
  return {
    ...demo,
    ...emptyHistoryRecords(),
    flights: [
      flight("recent-flight", NOW - DAY),
      flight("old-flight", NOW - 700 * DAY),
    ],
    // Five recent completed orders, so the old one is not among the latest
    // five the window keeps.
    workOrders: [
      ...[1, 2, 3, 4, 5].map((n) => order(`recent-${n}`, `2026-11-0${n}`)),
      order("old-order", "2019-03-04"),
    ],
    workOrderAttachments: [
      {
        uuid: "old-file",
        workOrderUuid: "old-order",
        name: "337.pdf",
        size: 1,
        uploadedAt: 0,
      },
    ],
  };
}

function flight(uuid: string, start: number): Flight {
  return {
    uuid,
    aircraftUuid: AIRCRAFT,
    authorId: "demo-admin",
    pilotId: "demo-admin",
    submittedAt: start,
    status: "accepted",
    startTime: new Date(start).toISOString(),
    landings: 1,
    cycles: 0,
    origin: "KSEA",
    destination: "KBFI",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
}

function uuids(rows: { uuid: string }[] | undefined) {
  return (rows ?? []).map((r) => r.uuid);
}
