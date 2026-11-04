/**
 * Responsibility: Pins which open work the parts plans list, in what order,
 *   and how parts requests total what is still needed.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/partsPlanning.ts, partsRequests.ts, workOrders.ts,
 *   tests/fixtures (parts, work orders).
 */
import { describe, expect, it } from "vitest";
import { neededPart, partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { maintenancePartsPlans, requestedParts } from "./partsPlanning";
import {
  applyRequestCommand,
  requestDraftSchema,
  type RequestSource,
} from "./partsRequests";
import { newWorkTask, saveWorkOrder } from "./workOrders";

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
