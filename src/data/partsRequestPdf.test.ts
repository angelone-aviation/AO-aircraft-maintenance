/**
 * Responsibility: Pins what the parts request PDF prints for orders, repair
 *   orders and packing slips.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/partsRequestPdf.ts, src/data/demo.ts.
 */
// @vitest-environment node
import { expect, it } from "vitest";
import { requestPdf } from "./partsRequestPdf";
import { demoSnapshot } from "./demo";
import type { PartsRequest, RequestPurchase } from "../domain/partsRequests";

function request(over: Partial<PartsRequest> = {}): PartsRequest {
  return {
    uuid: "req",
    number: "PR-1",
    mode: "parts",
    shipFrom: "FROM-ADDRESS",
    billTo: "BILL-ADDRESS",
    engineer: "",
    lines: [
      {
        uuid: "line",
        partNumber: "PN-1",
        description: "Pump",
        quantity: 1,
        componentTSN: 3600 * 12.34,
        componentTSO: null,
        quotedCents: 12345,
      },
    ],
    ...over,
  } as PartsRequest;
}

function purchase(purchasedBy: string): RequestPurchase {
  return {
    requestUuid: "req",
    lineUuid: "line",
    poUuid: "po",
    number: "PO-7",
    phase: "",
    quantity: 1,
    received: 0,
    shipped: 0,
    expectedDate: "",
    purchasedDate: "",
    purchasedBy,
  };
}

it("prints the order with each line's purchases, naming the buyer", () => {
  const s = demoSnapshot();
  s.partsRequestPurchases = [purchase(s.user.id), purchase("former-user")];
  const output = requestPdf(request(), s, "request").output();
  expect(output).toContain("(PARTS ORDER REQUEST PR-1)");
  expect(output).toContain("Purchase orders: PO-7)");
  expect(output).toContain(
    `(PO-7 | Qty 1 | Received 0 | Purchased Pending by ${s.user.name})`,
  );
  expect(output).toContain("by former-user)");
  expect(output).not.toContain("FROM-ADDRESS");
  expect(output).not.toContain("Repair tag");
});

it("adds the ship-from and bill-to addresses to a packing slip", () => {
  const output = requestPdf(request(), demoSnapshot(), "packing").output();
  expect(output).toContain("(PACKING SLIP PR-1)");
  expect(output).toContain("(From: FROM-ADDRESS)");
  expect(output).toContain("(Bill to: BILL-ADDRESS)");
});

it("prints a repair tag, component times and cost for each repair line", () => {
  const output = requestPdf(
    request({ mode: "repair", currency: "USD" }),
    demoSnapshot(),
    "request",
  ).output();
  expect(output).toContain("(REPAIR ORDER / TAG PR-1)");
  expect(output).toContain(
    "(Repair tag: PR-1-1 | Serial / batch: Not recorded)",
  );
  expect(output).toContain("(TSN: 12.3 h | TSO: Not recorded h)");
  expect(output).toContain("Estimated cost: USD 123.45)");
});
