/**
 * Responsibility: Pins the price a part is issued at (PT-12, decision D13):
 *   recorded on the work order's cost record, kept when the stock cost is
 *   corrected, and shown to program administrators only.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain (costs, partsRequests, management, workOrders,
 *   taskCards, boardView, programs, model), src/data/demo.ts,
 *   tests/fixtures/workOrders.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot, withDemoRole } from "../data/demo";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import {
  aircraftCostReport,
  applyCostCommand,
  budgetStatus,
  costRecordSchema,
  workOrderCosts,
  type WorkOrderCost,
} from "./costs";
import { boardCostTotals } from "./boardView";
import { applyManagement, type Stock } from "./management";
import {
  applyRequestCommand,
  requestDraftSchema,
  type RequestSource,
} from "./partsRequests";
import { taskCardDefaults } from "./taskCards";
import { newWorkTask, saveWorkOrder, type WorkOrder } from "./workOrders";
import { scopedSnapshot } from "./programs";
import type { Group, Snapshot } from "./model";

const NOW = Date.parse("2026-06-15T12:00:00");
const MINUTE_MS = 60_000;
const TODAY = "2026-06-15";
const YEAR = 2026;
const WHOLE_YEAR = { from: "2026-01-01", to: "2026-12-31" };
// A price no timestamp, uuid or count in the snapshot can contain as a whole
// number, so finding it in a role's snapshot means it leaked.
const ISSUED_DOLLARS = 1234.57;
const ISSUED_CENTS = 123_457;
const CORRECTED_DOLLARS = 1500;
const CORRECTED_CENTS = 150_000;
const LEAKED_PRICE = /\b(123457|1234\.57)\b/;

describe("issued part prices (PT-12)", () => {
  it("keeps past totals on every screen when the stock item's unit cost is corrected", () => {
    const f = fixture();
    f.issue(2);
    const before = totals(f);
    expect(before).toEqual({
      order: 2 * ISSUED_CENTS,
      year: 2 * ISSUED_CENTS,
      report: 2 * ISSUED_CENTS,
      board: 2 * ISSUED_CENTS,
    });
    f.correctCost(CORRECTED_DOLLARS);
    expect(totals(f)).toEqual(before);
  });

  it("records each issue as plain data on the work order's cost record, audited", () => {
    const f = fixture();
    f.issue(1);
    f.correctCost(CORRECTED_DOLLARS);
    f.issue(2);
    const [record] = workOrderRecords(f.s);
    expect(record).toMatchObject({ workOrderUuid: f.order.uuid, version: 2 });
    expect(record.issuedParts).toEqual([
      issued(f.issuedAt[0], 1, ISSUED_CENTS),
      issued(f.issuedAt[1], 2, CORRECTED_CENTS),
    ]);
    const rows = f.s.audit.filter((a) => a.action === "cost.part.issue");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      entityUuid: record.uuid,
      programUuid: "demo-program",
      reason: f.s.aircraft[0].registration,
    });
    // Cost rows carry no aircraft, so only administrators read them.
    expect(rows[0]).not.toHaveProperty("aircraftUuid");
    expect(JSON.parse(rows[0].after!)).toEqual(record);
    expect(JSON.parse(rows[0].before!).issuedParts).toHaveLength(1);
    expect(rows[1].before).toBeUndefined();
  });

  it("shows each price as its own line, merged under a manual unit cost", () => {
    const f = fixture();
    f.issue(1);
    f.correctCost(CORRECTED_DOLLARS);
    f.issue(2);
    expect(workOrderCosts(f.s, f.order).parts).toMatchObject([
      { quantity: 1, unitCents: ISSUED_CENTS, totalCents: ISSUED_CENTS },
      { quantity: 2, unitCents: CORRECTED_CENTS, totalCents: 300_000 },
    ]);
    applyCostCommand(f.s, {
      action: "part.unitCost",
      workOrderUuid: f.order.uuid,
      stockUuid: "lot",
      unitCents: 100,
    });
    expect(workOrderCosts(f.s, f.order).parts).toMatchObject([
      { quantity: 3, unitCents: 100, manual: true, totalCents: 300 },
    ]);
  });

  it("pairs two issues made in the same millisecond with their prices in order", () => {
    const f = fixture();
    f.move("reserve", 3);
    const at = f.tick();
    applyRequestCommand(f.s, f.command("issue", 1), at);
    f.correctCost(CORRECTED_DOLLARS);
    applyRequestCommand(f.s, f.command("issue", 2), at);
    expect(workOrderCosts(f.s, f.order).partsCents).toBe(
      ISSUED_CENTS + 2 * CORRECTED_CENTS,
    );
  });

  it("prices an issue saved before prices were recorded at the stock item's current cost", () => {
    const f = fixture();
    f.issue(1);
    // Saved before D13: on the request, with no price on the cost record.
    f.s.partsRequests![0].issues.push({
      lineUuid: "line",
      stockUuid: "lot",
      quantity: 1,
      at: NOW,
      actorId: f.s.user.id,
      date: TODAY,
    });
    const record = workOrderRecords(f.s)[0];
    const { issuedParts: _none, ...old } = record;
    expect(costRecordSchema.parse(old)).not.toHaveProperty("issuedParts");
    f.correctCost(CORRECTED_DOLLARS);
    // Characterizes current behaviour: the old issue follows the stock cost.
    expect(workOrderCosts(f.s, f.order).partsCents).toBe(
      ISSUED_CENTS + CORRECTED_CENTS,
    );
    f.s.costs = [old];
    expect(workOrderCosts(f.s, f.order).partsCents).toBe(2 * CORRECTED_CENTS);
  });

  it("keeps a part issued without a stock cost unpriced when a cost is set later", () => {
    const f = fixture();
    f.correctCost(undefined);
    f.issue(1);
    expect(workOrderRecords(f.s)[0].issuedParts).toEqual([
      issued(f.issuedAt[0], 1, undefined),
    ]);
    f.correctCost(ISSUED_DOLLARS);
    const costs = workOrderCosts(f.s, f.order);
    expect(costs).toMatchObject({ partsCents: 0, missingPartCosts: 1 });
  });

  it("records on closed work orders and archived job cards, and for no other request", () => {
    const f = fixture();
    f.s.workOrders![0].status = "completed";
    f.issue(1);
    expect(workOrderRecords(f.s)[0].issuedParts).toHaveLength(1);

    const card = fixture((s, order) => {
      s.taskCards = [jobCard(s, order)];
      return { kind: "jobCard", uuid: "card", workOrderUuid: "" };
    });
    card.s.archivedTaskCards = card.s.taskCards;
    card.s.taskCards = [];
    card.issue(1);
    expect(workOrderRecords(card.s)[0].issuedParts).toEqual([
      issued(card.issuedAt[0], 1, ISSUED_CENTS),
    ]);

    const loose = fixture(() => ({
      kind: "discrepancy",
      uuid: "demo-report",
      workOrderUuid: "",
    }));
    loose.issue(1);
    expect(loose.s.costs).toEqual([]);
    expect(loose.s.audit.some((a) => a.action.startsWith("cost."))).toBe(false);
  });

  it("keeps recorded prices through releases, cancellation and a replayed issue", () => {
    const f = fixture();
    f.move("reserve", 3);
    const issue = f.command("issue", 1);
    applyRequestCommand(f.s, issue, f.tick());
    applyRequestCommand(f.s, issue, f.tick());
    f.move("release", 1);
    applyRequestCommand(
      f.s,
      {
        kind: "cancel",
        requestUuid: crypto.randomUUID(),
        uuid: "request",
        version: f.s.partsRequests![0].version,
        reason: "Work deferred",
      },
      f.tick(),
    );
    expect(workOrderRecords(f.s)[0].issuedParts).toHaveLength(1);
    expect(workOrderCosts(f.s, f.order).partsCents).toBe(ISSUED_CENTS);
  });
});

describe("who sees issue prices (D13)", () => {
  it("shows the recorded price to program administrators", () => {
    const f = fixture();
    f.issue(2);
    const admin = scopedSnapshot(f.s);
    expect(workOrderRecords(admin)[0].issuedParts).toHaveLength(1);
    expect(admin.audit.some((a) => a.action === "cost.part.issue")).toBe(true);
  });

  it("never shows it to mechanics or pilots, though they read the request", () => {
    const f = fixture();
    f.issue(2);
    for (const role of [asMechanic(f.s), asPilot(f.s)]) {
      const view = scopedSnapshot(role);
      expect(view.partsRequests?.[0].issues).toHaveLength(1);
      expect(workOrderRecords(view)[0]).not.toHaveProperty("issuedParts");
      expect(view.management?.some((r) => r.kind === "stock")).toBe(false);
      expect(view.audit.map((a) => a.action)).not.toContain("cost.part.issue");
      expect(JSON.stringify(view)).not.toMatch(LEAKED_PRICE);
    }
  });

  it("gives owners nothing and board members totals at the issue price only", () => {
    const f = fixture();
    f.issue(2);
    f.correctCost(CORRECTED_DOLLARS);
    const owner = scopedSnapshot(withDemoRole(f.s, "owner"));
    expect(owner.costs).toBeUndefined();
    expect(JSON.stringify(owner)).not.toMatch(LEAKED_PRICE);
    const board = scopedSnapshot(withDemoRole(f.s, "board"), TODAY);
    expect(board.costs).toBeUndefined();
    expect(
      board.boardCosts?.find((c) => c.aircraftUuid === f.order.aircraftUuid),
    ).toMatchObject({ yearCents: 2 * ISSUED_CENTS });
    expect(JSON.stringify(board)).not.toMatch(LEAKED_PRICE);
  });
});

type Fixture = ReturnType<typeof fixture>;
type Move = "reserve" | "release" | "issue";

// The demo administrator, a work order with one manual task, a lot of four
// cylinders at ISSUED_DOLLARS, and a request for them on the task, or on the
// source `sourceOf` sets up. Each command runs a minute after the last.
function fixture(sourceOf?: (s: Snapshot, order: WorkOrder) => RequestSource) {
  const s = demoSnapshot();
  const save = workOrderCommand();
  save.tasks = [
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, "Cylinder"),
  ];
  const order = saveWorkOrder(s, save, NOW);
  s.management = [location(), lot()];
  s.costs = [];
  let clock = NOW;
  const tick = () => (clock += MINUTE_MS);
  const task = { kind: "workTask", uuid: order.tasks[0].uuid } as const;
  const source = sourceOf?.(s, order) ?? { ...task, workOrderUuid: order.uuid };
  saveRequest(s, source, tick());
  const issuedAt: number[] = [];
  const command = (kind: Move, quantity: number) =>
    stockCommand(s, kind, quantity);
  const move = (kind: Move, quantity: number) => {
    const at = tick();
    if (kind === "issue") issuedAt.push(at);
    return applyRequestCommand(s, command(kind, quantity), at);
  };
  const issue = (quantity: number) => {
    move("reserve", quantity);
    return move("issue", quantity);
  };
  const correctCost = (cost: number | undefined) =>
    applyManagement(
      s,
      {
        action: "record.save",
        requestUuid: crypto.randomUUID(),
        reason: "Vendor invoice",
        record: { ...findLot(s), cost },
      },
      tick(),
    );
  return { s, order, issuedAt, tick, command, move, issue, correctCost };
}

function jobCard(s: Snapshot, order: WorkOrder) {
  return {
    ...taskCardDefaults(order.aircraftUuid),
    uuid: "card",
    version: 1,
    cardNumber: "JC-1",
    title: "Cylinder",
    workOrderUuid: order.uuid,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: s.user.id,
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
  };
}

function saveRequest(s: Snapshot, source: RequestSource, now: number) {
  return applyRequestCommand(
    s,
    {
      kind: "save",
      requestUuid: crypto.randomUUID(),
      draft: requestDraftSchema.parse({
        uuid: "request",
        version: 0,
        source,
        mode: "parts",
        date: TODAY,
        engineer: "Tech",
        priority: "P2 Routine",
        requiredBy: "",
        currency: "USD",
        lines: [
          {
            uuid: "line",
            partNumber: "CYL-1",
            description: "Cyl",
            quantity: 4,
          },
        ],
      }),
    },
    now,
  );
}

function stockCommand(s: Snapshot, kind: Move, quantity: number) {
  return {
    kind,
    requestUuid: crypto.randomUUID(),
    uuid: "request",
    version: s.partsRequests!.find((r) => r.uuid === "request")!.version,
    lineUuid: "line",
    stockUuid: "lot",
    quantity,
    alternateConfirmed: false,
    date: TODAY,
  };
}

function totals({ s, order }: Fixture) {
  const aircraft = order.aircraftUuid;
  return {
    order: workOrderCosts(s, order).partsCents,
    year: budgetStatus(s, aircraft, YEAR).actualCents,
    report: aircraftCostReport(s, aircraft, WHOLE_YEAR).partsCents,
    board: boardCostTotals(s, TODAY).find((c) => c.aircraftUuid === aircraft)
      ?.yearCents,
  };
}

function issued(issuedAt: number, quantity: number, unitCents?: number) {
  return {
    requestUuid: "request",
    issuedAt,
    stockUuid: "lot",
    quantity,
    date: TODAY,
    unitCents,
  };
}

function workOrderRecords(s: Snapshot) {
  return (s.costs ?? []).filter(
    (r): r is WorkOrderCost => r.kind === "workOrder",
  );
}

function findLot(s: Snapshot) {
  return s.management!.find(
    (r): r is Stock => r.kind === "stock" && r.uuid === "lot",
  )!;
}

function asMechanic(s: Snapshot): Snapshot {
  const group: Group = {
    id: "mx",
    name: "Maintenance",
    programUuid: "demo-program",
    aircraftIds: [],
    permissions: ["read", "maintenance"],
  };
  const user = { ...s.user, id: "tech", isAdmin: false, groupIds: ["mx"] };
  return { ...s, user, groups: [...s.groups, group] };
}

function asPilot(s: Snapshot): Snapshot {
  return { ...s, user: s.members.find((m) => m.id === "demo-pilot")! };
}

function location() {
  return {
    uuid: "store",
    version: 1,
    programUuid: "demo-program",
    kind: "location" as const,
    name: "Store",
    address: "",
    contact: "",
  };
}

function lot(): Stock {
  return {
    uuid: "lot",
    version: 1,
    programUuid: "demo-program",
    kind: "stock",
    partNumber: "CYL-1",
    description: "Cylinder",
    category: "part",
    condition: "new",
    locationUuid: "store",
    quantity: 4,
    minimum: 0,
    alternates: "",
    cost: ISSUED_DOLLARS,
  };
}
