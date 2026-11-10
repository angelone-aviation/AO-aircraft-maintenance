/**
 * Responsibility: Pins what the parts request PDF prints for orders, repair
 *   orders and packing slips, with text outside Latin-1 as entered.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/partsRequestPdf.ts, src/data/demo.ts,
 *   tests/fixtures/pdfText.
 */
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestPdf } from "./partsRequestPdf";
import { demoSnapshot } from "./demo";
import { pdfLines, serveDejaVuFont } from "../../tests/fixtures/pdfText";
import type { PartsRequest, RequestPurchase } from "../domain/partsRequests";

beforeEach(serveDejaVuFont);
afterEach(() => vi.unstubAllGlobals());

// Each printed line on a line of its own, so "\nX\n" matches a whole line.
const printed = async (doc: Parameters<typeof pdfLines>[0]) =>
  `\n${(await pdfLines(doc)).join("\n")}\n`;

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

it("prints the order with each line's purchases, naming the buyer", async () => {
  const s = demoSnapshot();
  s.partsRequestPurchases = [purchase(s.user.id), purchase("former-user")];
  const output = await printed(await requestPdf(request(), s, "request"));
  expect(output).toContain("\nPARTS ORDER REQUEST PR-1\n");
  expect(output).toContain("Purchase orders: PO-7\n");
  expect(output).toContain(
    `\nPO-7 | Qty 1 | Received 0 | Purchased Pending by ${s.user.name}\n`,
  );
  expect(output).toContain("by former-user\n");
  expect(output).not.toContain("FROM-ADDRESS");
  expect(output).not.toContain("Repair tag");
});

it("adds the ship-from and bill-to addresses to a packing slip", async () => {
  const output = await printed(
    await requestPdf(request(), demoSnapshot(), "packing"),
  );
  expect(output).toContain("\nPACKING SLIP PR-1\n");
  expect(output).toContain("\nFrom: FROM-ADDRESS\n");
  expect(output).toContain("\nBill to: BILL-ADDRESS\n");
});

it("prints a repair tag, component times and cost for each repair line", async () => {
  const output = await printed(
    await requestPdf(
      request({ mode: "repair", currency: "USD" }),
      demoSnapshot(),
      "request",
    ),
  );
  expect(output).toContain("\nREPAIR ORDER / TAG PR-1\n");
  expect(output).toContain(
    "\nRepair tag: PR-1-1 | Serial / batch: Not recorded\n",
  );
  expect(output).toContain("\nTSN: 12.3 h | TSO: Not recorded h\n");
  expect(output).toContain("Estimated cost: USD 123.45\n");
});

it("prints a vendor and description outside Latin-1 as entered", async () => {
  const r = request({ vendor: "Łódź Aero" });
  r.lines[0].description = "Bolt ⅜ in ≥ 10 kΩ";
  const output = await printed(await requestPdf(r, demoSnapshot(), "request"));
  expect(output).toContain("Łódź Aero");
  expect(output).toContain("Bolt ⅜ in ≥ 10 kΩ");
});
