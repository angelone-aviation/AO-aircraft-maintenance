/**
 * Responsibility: Pins what the purchase order PDF prints: the draft marker,
 *   amounts, and the parts requests and repair work its lines fill.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/poPdf.ts, src/data/demo.ts.
 */
// @vitest-environment node
import { expect, it } from "vitest";
import { poPdf } from "./poPdf";
import { demoSnapshot } from "./demo";
import type { PurchaseOrder } from "../domain/purchaseOrders";

const allocation = { requestUuid: "request", lineUuid: "item", quantity: 2 };

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    number: "PO-1",
    phase: "issued",
    currency: "USD",
    shippingCents: 500,
    receipts: [],
    shipments: [],
    vendorContact: "",
    notes: "",
    lines: [
      {
        uuid: "line",
        partNumber: "PN-1",
        description: "Pump",
        quantity: 2,
        unitCents: 1250,
        kind: "part",
        cancelled: 0,
        repairComponentUuid: "pump",
        repairWork: "overhaul",
        requestAllocations: [allocation],
      },
    ],
    ...over,
  } as PurchaseOrder;
}

function snapshot() {
  const s = demoSnapshot();
  s.partsRequests = [
    {
      uuid: "request",
      number: "PR-9",
      aircraftRegistration: "",
      lines: [{ uuid: "item", defect: "Leak", workRequested: "Reseal" }],
    },
  ] as never;
  return s;
}

it("prints amounts, the requests a line fills and their repair work", () => {
  const output = poPdf(order(), snapshot()).output();
  expect(output).toContain("(Qty: 2 | Unit: USD 12.50 | Amount: USD 25.00)");
  expect(output).toContain("(Request: PR-9 | Aircraft: Stock | Allocated: 2)");
  expect(output).toContain("(Repair service: overhaul | Serial: Not recorded)");
  expect(output).toContain("(Work requested: Reseal)");
  expect(output).toContain("(Total ordered: USD 30.00)");
  expect(output).not.toContain("DRAFT");
});

it("prints repair work only on repair lines", () => {
  const [line] = order().lines;
  const parts = order({ lines: [{ ...line, repairComponentUuid: undefined }] });
  const output = poPdf(parts, snapshot()).output();
  expect(output).toContain("(Request: PR-9 | Aircraft: Stock | Allocated: 2)");
  expect(output).not.toContain("Repair service:");
});

it("marks a draft and leaves allocations out without a snapshot", () => {
  const output = poPdf(order({ phase: "draft" })).output();
  expect(output).toContain("(DRAFT - NOT ISSUED)");
  expect(output).not.toContain("Request:");
  expect(output).not.toContain("Repair service:");
});
