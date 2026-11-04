/**
 * Responsibility: Pins which open work the parts plans list, in what order,
 *   and how parts requests total what is still needed.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/partsPlanning.ts, partsRequests.ts, workOrders.ts,
 *   airworthiness.ts, tests/fixtures (parts, work orders, the due fleet).
 */
import { describe, expect, it } from "vitest";
import { DUE_FLEET_PART, dueFleet } from "../../tests/fixtures/dueFleet";
import { neededPart, partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import {
  maintenancePartsPlans,
  plannedNeedsFor,
  requestedParts,
  type PartsPlan,
} from "./partsPlanning";
import {
  applyRequestCommand,
  requestDraftSchema,
  type RequestSource,
} from "./partsRequests";
import { newWorkTask, saveWorkOrder } from "./workOrders";
import { adSchema } from "./airworthiness";

const now = Date.parse("2026-10-02T12:00:00Z");

function fixture() {
  const s = partsFixture();
  s.user.isAdmin = true;
  const order = saveWorkOrder(
    s,
    {
      ...workOrderCommand(),
      tasks: [
        newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, "Mirror"),
        newWorkTask({ kind: "discrepancy", uuid: "parts-report" }, "Filter"),
      ],
    },
    now,
  );
  const [manual, discrepancy] = order.tasks.map((t): RequestSource => ({
    kind: "workTask",
    uuid: t.uuid,
    workOrderUuid: order.uuid,
  }));
  const request = (uuid: string, source: RequestSource, quantity = 2) =>
    applyRequestCommand(s, {
      kind: "save",
      requestUuid: uuid,
      draft: requestDraftSchema.parse({
        uuid,
        version: 0,
        source,
        recurring: false,
        mode: "parts",
        date: "2026-10-20",
        engineer: "Tech",
        priority: "P2 Routine",
        requiredBy: "",
        currency: "USD",
        lines: [
          {
            uuid: "line",
            partNumber: "MIRROR",
            description: "Mirror",
            quantity,
          },
        ],
      }),
    });
  return { s, order, manual, discrepancy, request };
}

const line = (quantity: number, onOrder = 0, shipped = 0) => ({
  stockUuid: "",
  locationUuid: "",
  partNumber: "MIRROR",
  quantity,
  onOrder,
  shipped,
});

describe("parts plans", () => {
  it("list record work first, then other requests once per source", () => {
    const { s, order, manual, discrepancy, request } = fixture();
    const inspection = s.inspections[0];
    inspection.requiredParts = [neededPart];
    s.discrepancies[0].requiredParts = [neededPart];
    request("first", manual);
    request("second", manual);
    request("through-record", discrepancy, 1);
    const plans = maintenancePartsPlans(s);
    expect(plans.map((p) => p.uuid)).toEqual([
      inspection.uuid,
      "parts-report",
      manual.uuid,
    ]);
    // The discrepancy's request replaces the parts recorded on it.
    expect(plans[1].parts).toEqual([line(1)]);
    expect(plans[2]).toEqual({
      uuid: manual.uuid,
      aircraftUuid: order.aircraftUuid,
      label: `${order.number}: Mirror`,
      upcoming: true,
      parts: [line(2), line(2)],
    });
  });

  it("drop a record whose only request is cancelled, and work that closed", () => {
    const { s, order, manual, discrepancy, request } = fixture();
    s.discrepancies[0].requiredParts = [neededPart];
    request("through-record", discrepancy).cancelled = true;
    request("manual", manual);
    expect(requestedParts(s, discrepancy)).toEqual([]);
    expect(maintenancePartsPlans(s).map((p) => p.uuid)).toEqual([manual.uuid]);
    s.workOrders!.find((w) => w.uuid === order.uuid)!.tasks[0].status =
      "cancelled";
    expect(requestedParts(s, manual)).toEqual([]);
    expect(maintenancePartsPlans(s)).toEqual([]);
  });
});

describe("requested parts", () => {
  it("is undefined for a source no parts request names", () => {
    const { s, manual } = fixture();
    expect(requestedParts(s, manual)).toBeUndefined();
  });

  it("subtracts reserved and issued parts, showing what is on order and shipped", () => {
    const { s, manual, request } = fixture();
    const r = request("manual", manual, 5);
    r.reservations.push({ lineUuid: "line", stockUuid: "stock", quantity: 1 });
    r.issues.push({
      lineUuid: "line",
      stockUuid: "stock",
      quantity: 1,
      actorId: s.user.id,
      at: now,
    });
    s.partsRequestPurchases = [
      {
        requestUuid: r.uuid,
        lineUuid: "line",
        poUuid: "po",
        number: "PO-1",
        phase: "ordered",
        quantity: 2,
        received: 1,
        shipped: 2,
        expectedDate: "",
        purchasedDate: "",
        purchasedBy: "",
      },
    ];
    expect(requestedParts(s, manual)).toEqual([line(3, 2, 1)]);
  });
});

describe("planned needs for a stock lot", () => {
  const plan = (uuid: string, parts: PartsPlan["parts"]): PartsPlan => ({
    uuid,
    aircraftUuid: "aircraft",
    label: uuid,
    upcoming: true,
    parts,
  });

  it("lists, in plan order, the plans naming the lot by id or part number, with the first such part's quantity", () => {
    const filter = { ...line(4), partNumber: "FILTER-1" };
    const plans = [
      plan("by-number", [line(1), filter, neededPart]),
      plan("elsewhere", [{ ...neededPart, stockUuid: "remote-stock" }]),
      plan("by-id", [neededPart, filter]),
    ];
    const needs = plannedNeedsFor(plans, {
      uuid: neededPart.stockUuid,
      partNumber: "FILTER-1",
    });
    expect(needs.map((n) => [n.plan, n.quantity])).toStrictEqual([
      [plans[0], 4],
      [plans[2], 3],
    ]);
  });
});

describe("on the due fleet", () => {
  // Characterizes current behaviour, including an AD on a removed component
  // and one on an aircraft the snapshot does not hold.
  it("plans record work with parts in record order", () => {
    const { s } = dueFleet();
    expect(
      maintenancePartsPlans(s).map((p) =>
        [p.uuid, p.aircraftUuid, p.label, p.upcoming, p.parts.length].join(
          " | ",
        ),
      ),
    ).toStrictEqual([
      "i-zero | demo-206 | i-zero | true | 1",
      "i-other | demo-208 | i-other | true | 1",
      "i-ok | demo-206 | i-ok | false | 1",
      "r-now | demo-206 | Type pump: r-now limit | true | 1",
      "r-tracked | demo-206 | Type pump: r-tracked limit | false | 1",
      "ad-removed/hourly-300 | demo-206 | AD AD-REMOVED: Inspect | false | 1",
      "ad-overdue/monthly-2020-01-01 | demo-206 | AD AD-OVERDUE: Inspect | true | 1",
      "ad-unset/task | demo-206 | AD AD-UNSET: Inspect | true | 1",
      "ad-counter/hourly-500 | demo-206 | AD AD-COUNTER: Inspect | true | 1",
      "ad-b/monthly-2020-01-01 | demo-208 | AD AD-B: Inspect | true | 1",
      "ad-gone/monthly-2020-01-01 | gone | AD AD-GONE: Inspect | true | 1",
    ]);
  });

  it("plans a reviewed AD's parts only when it is tracked", () => {
    const planned = (applicability: string) => {
      const { s } = dueFleet();
      const overdue = s.airworthiness!.find((r) => r.uuid === "ad-overdue")!;
      Object.assign(overdue, { applicability });
      return maintenancePartsPlans(s).some((p) =>
        p.uuid.startsWith("ad-overdue/"),
      );
    };
    expect(adSchema.shape.applicability.options.filter(planned)).toEqual([
      "Applicable",
      "Previously Complied With (PCW)",
    ]);
  });

  it("skips work with parts whose status it cannot compute, as the alerts do", () => {
    const plannedWith = (uuid: string) => {
      const { s } = dueFleet();
      const records = [...s.inspections, ...(s.management ?? [])];
      Object.assign(
        records.find((r) => r.uuid === uuid)!,
        {
          requiredParts: [DUE_FLEET_PART],
        },
      );
      return maintenancePartsPlans(s).map((p) => p.uuid);
    };
    const planned = maintenancePartsPlans(dueFleet().s).map((p) => p.uuid);
    expect(plannedWith("i-missing")).toStrictEqual(planned);
    expect(plannedWith("r-early")).toStrictEqual(planned);
    expect(plannedWith("i-cycles")).toContain("i-cycles");
  });
});
