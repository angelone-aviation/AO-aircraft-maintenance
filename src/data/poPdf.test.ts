/**
 * Responsibility: Pins what the purchase order PDF prints: the draft marker,
 *   amounts, the parts requests and repair work its lines fill, and text
 *   outside Latin-1 exactly as entered.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/poPdf.ts, src/data/demo.ts, tests/fixtures/pdfText.
 */
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { poPdf } from "./poPdf";
import { demoSnapshot } from "./demo";
import { pdfLines, serveDejaVuFont } from "../../tests/fixtures/pdfText";
import type { PurchaseOrder } from "../domain/purchaseOrders";

const allocation = { requestUuid: "request", lineUuid: "item", quantity: 2 };

beforeEach(serveDejaVuFont);
afterEach(() => vi.unstubAllGlobals());

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    number: "PO-1",
    phase: "issued",
    currency: "USD",
    shippingCents: 500,
    receipts: [],
    shipments: [],
    vendor: "Vendor",
    vendorContact: "",
    shipTo: "Hangar",
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

it("prints amounts, the requests a line fills and their repair work", async () => {
  const lines = await pdfLines(await poPdf(order(), snapshot()));
  expect(lines).toEqual(
    expect.arrayContaining([
      "Qty: 2 | Unit: USD 12.50 | Amount: USD 25.00",
      "Request: PR-9 | Aircraft: Stock | Allocated: 2",
      "Repair service: overhaul | Serial: Not recorded",
      "Work requested: Reseal",
      "Total ordered: USD 30.00",
    ]),
  );
  expect(lines.join("\n")).not.toContain("DRAFT");
  expect(fetch).toHaveBeenCalledWith("/fonts/DejaVuSans.ttf");
});

it("prints repair work only on repair lines", async () => {
  const [line] = order().lines;
  const parts = order({ lines: [{ ...line, repairComponentUuid: undefined }] });
  const lines = await pdfLines(await poPdf(parts, snapshot()));
  expect(lines).toContain("Request: PR-9 | Aircraft: Stock | Allocated: 2");
  expect(lines.join("\n")).not.toContain("Repair service:");
});

it("marks a draft and leaves allocations out without a snapshot", async () => {
  const lines = await pdfLines(await poPdf(order({ phase: "draft" })));
  expect(lines).toContain("DRAFT - NOT ISSUED");
  expect(lines.join("\n")).not.toContain("Request:");
  expect(lines.join("\n")).not.toContain("Repair service:");
});

it("prints vendor, address and descriptions outside Latin-1 as entered", async () => {
  const [line] = order().lines;
  const po = order({
    vendor: "Łódź Aero",
    shipTo: "Żwirki i Wigury 1 №5, Łódź",
    lines: [
      {
        ...line,
        partNumber: "AN3-5A",
        description: "Bolt ⅜ in ≥ 10 kΩ",
        repairComponentUuid: undefined,
        requestAllocations: [],
      },
    ],
  });
  expect(await pdfLines(await poPdf(po))).toEqual(
    expect.arrayContaining([
      "Vendor: Łódź Aero",
      "Deliver to: Żwirki i Wigury 1 №5, Łódź",
      "1. AN3-5A - Bolt ⅜ in ≥ 10 kΩ",
    ]),
  );
});

it("asks the user to reconnect when the font cannot be loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  await expect(poPdf(order())).rejects.toThrow(
    "Unable to load the PDF font. Reconnect and try again.",
  );
});
