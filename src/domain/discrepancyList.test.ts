/**
 * Responsibility: Pins how the Discrepancies screen reads its reports: each
 *   report's standing, the summary counts, the listed reports and their
 *   order, and the work orders that cover a report.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/discrepancyList.ts, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Deferral } from "./deferrals";
import {
  discrepancyCounts,
  listedReports,
  reportStanding,
  reportWorkOrders,
} from "./discrepancyList";
import type { Discrepancy, Snapshot } from "./model";
import type { TaskCard } from "./taskCards";
import type { WorkOrder } from "./workOrders";

const TODAY = "2026-11-12";
const DEMO = demoSnapshot();
const [N206] = DEMO.aircraft;

describe("reportStanding", () => {
  it("reads open, grounding, deferred, expired and resolved", () => {
    expect(reportStanding(report("a"), TODAY)).toBe("open");
    expect(reportStanding(report("b", { grounding: true }), TODAY)).toBe(
      "grounding",
    );
    const deferred = report("c", {
      grounding: true,
      deferral: deferral("2026-11-12"),
    });
    expect(reportStanding(deferred, TODAY)).toBe("deferred");
    expect(reportStanding(deferred, "2026-11-13")).toBe("expired");
    const noExpiry = report("d", { deferral: deferral(undefined) });
    expect(reportStanding(noExpiry, "2099-01-01")).toBe("deferred");
    const resolved = report("e", {
      status: "resolved",
      grounding: true,
      deferral: deferral("2026-01-01"),
    });
    expect(reportStanding(resolved, TODAY)).toBe("resolved");
  });
});

describe("discrepancyCounts", () => {
  it("counts open, grounding, deferred and this month's resolutions", () => {
    const counts = discrepancyCounts(
      [
        report("open"),
        report("grounds", { grounding: true }),
        report("deferred", { grounding: true, deferral: deferral(TODAY) }),
        resolved("this-month", new Date(2026, 10, 1, 0, 5)),
        resolved("last-month", new Date(2026, 9, 31, 23, 55)),
        report("never-dated", { status: "resolved" }),
      ],
      TODAY,
    );
    expect(counts).toEqual({
      open: 3,
      grounding: 1,
      deferred: 1,
      resolvedThisMonth: 1,
      total: 6,
    });
  });
});

describe("listedReports", () => {
  const s: Snapshot = {
    ...DEMO,
    discrepancies: [
      report("old", { createdAt: 1 }),
      report("new", { createdAt: 3 }),
      report("fixed", { createdAt: 2, status: "resolved" }),
    ],
  };

  it("lists open reports newest first, and resolved ones on request", () => {
    const open = listedReports(s, { search: "", showResolved: false });
    expect(open.reports.map((d) => d.uuid)).toEqual(["new", "old"]);
    const all = listedReports(s, { search: "", showResolved: true });
    expect(all.reports.map((d) => d.uuid)).toEqual(["new", "fixed", "old"]);
  });

  it("says whether anything was listed before the search", () => {
    expect(listedReports(s, { search: "zzz", showResolved: false })).toEqual({
      reports: [],
      anyListed: true,
    });
    const none = { ...s, discrepancies: [] };
    expect(listedReports(none, { search: "", showResolved: true })).toEqual({
      reports: [],
      anyListed: false,
    });
  });
});

describe("reportWorkOrders", () => {
  it("finds orders holding the report as an item or through a job card", () => {
    const item = order("item", "d1");
    const viaCard = order("card", "other");
    const unrelated = order("unrelated", "other");
    const card = {
      uuid: "c1",
      discrepancyUuid: "d1",
      workOrderUuid: "card",
    } as TaskCard;
    const s = {
      ...DEMO,
      workOrders: [item, viaCard, unrelated],
      taskCards: [card],
    };
    expect(reportWorkOrders(s, "d1").map((w) => w.uuid)).toEqual([
      "item",
      "card",
    ]);
    expect(reportWorkOrders(DEMO, "d1")).toEqual([]);
  });
});

function report(uuid: string, extra: Partial<Discrepancy> = {}): Discrepancy {
  return {
    uuid,
    aircraftUuid: N206.uuid,
    description: `Report ${uuid}`,
    status: "open",
    authorId: DEMO.user.id,
    createdAt: 0,
    ...extra,
  };
}

function resolved(uuid: string, at: Date): Discrepancy {
  return report(uuid, { status: "resolved", resolvedAt: at.getTime() });
}

function deferral(expiresOn: string | undefined): Deferral {
  return {
    type: "mel",
    melItem: "33-40-01",
    category: "C",
    placard: "INOP",
    deferredOn: "2026-11-02",
    deferredAt: 0,
    deferredBy: DEMO.user.id,
    deferredByName: "Alex Morgan",
    expiresOn,
  } as Deferral;
}

function order(uuid: string, discrepancyUuid: string): WorkOrder {
  return {
    uuid,
    tasks: [{ source: { kind: "discrepancy", uuid: discrepancyUuid } }],
  } as WorkOrder;
}
