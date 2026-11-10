/**
 * Responsibility: Prints a purchase order as a PDF to send to the vendor.
 * Layer: Data. Browser-side PDF document; no React.
 * Dependencies: src/data/pdfLayout.ts, src/data/pdfFont.ts,
 *   src/domain/model.ts, src/domain/purchaseOrders.ts.
 */
import { paragraphPdf, type Paragraph } from "./pdfLayout";
import { loadDejaVuFont } from "./pdfFont";
import { localDate, type Snapshot } from "../domain/model";
import {
  poStatus,
  poTotal,
  type PurchaseOrder,
} from "../domain/purchaseOrders";

const CENTS_PER_UNIT = 100;

type POLine = PurchaseOrder["lines"][number];
type Allocation = NonNullable<POLine["requestAllocations"]>[number];

/**
 * Lays out a purchase order: status, revision and date, vendor and delivery,
 * each line with its amount and the parts requests it fills, then shipping
 * and the total. A draft is marked "DRAFT - NOT ISSUED".
 *
 * @param po - The purchase order.
 * @param snapshot - Holds the parts requests its lines are allocated to;
 *   without it, allocations are left out.
 * @returns The document, ready for `save()`, in DejaVu Sans so vendor
 *   names, addresses and descriptions print as entered.
 * @throws {Error} "Unable to load the PDF font. Reconnect and try again." when
 *   the font request fails with an HTTP error; a network failure rejects with
 *   fetch's own error.
 */
export async function poPdf(po: PurchaseOrder, snapshot?: Snapshot) {
  const out: Paragraph[] = [
    { text: `PURCHASE ORDER ${po.number}`, bold: true },
    {
      text: `${poStatus(po)} | Revision ${po.revision} | ${localDate(po.issuedAt ?? po.createdAt)}`,
    },
  ];
  if (po.phase === "draft")
    out.push({ text: "DRAFT - NOT ISSUED", bold: true });
  out.push(
    { text: `Vendor: ${po.vendor}`, bold: true },
    { text: po.vendorContact },
    { text: `Deliver to: ${po.shipTo}` },
    { text: `Expected delivery: ${po.expectedDate || "Not specified"}` },
  );
  for (const [i, l] of po.lines.entries())
    out.push(...listLineParagraphs(po, i, l, snapshot));
  out.push(
    { text: `Shipping: ${formatMoney(po, po.shippingCents)}` },
    { text: `Total ordered: ${formatMoney(po, poTotal(po))}`, bold: true },
    { text: po.notes },
  );
  return paragraphPdf(out, await loadDejaVuFont());
}

function formatMoney(po: PurchaseOrder, cents: number): string {
  return `${po.currency} ${(cents / CENTS_PER_UNIT).toFixed(2)}`;
}

function listLineParagraphs(
  po: PurchaseOrder,
  i: number,
  l: POLine,
  snapshot?: Snapshot,
): Paragraph[] {
  const out: Paragraph[] = [
    { text: `${i + 1}. ${l.partNumber} - ${l.description}`, bold: true },
  ];
  if (l.sprucePart)
    out.push({
      text: `Aircraft Spruce part: ${l.sprucePart.partNumber} | Order unit: ${l.sprucePart.uom || "Verify unit"}`,
    });
  out.push({
    text: `Qty: ${l.quantity} | Unit: ${formatMoney(po, l.unitCents)} | Amount: ${formatMoney(po, l.quantity * l.unitCents)}`,
  });
  for (const a of l.requestAllocations ?? [])
    out.push(...listAllocationParagraphs(l, a, snapshot));
  if (l.cancelled) out.push({ text: `Cancelled quantity: ${l.cancelled}` });
  if (l.kind === "component")
    out.push({
      text: `Trackable component | ${l.componentType} | ${l.manufacturer} ${l.model}`,
    });
  return out;
}

// A repair line also carries the component and work from the request line.
function listAllocationParagraphs(
  l: POLine,
  a: Allocation,
  snapshot?: Snapshot,
): Paragraph[] {
  const request = snapshot?.partsRequests?.find(
    (r) => r.uuid === a.requestUuid,
  );
  const item = request?.lines.find((r) => r.uuid === a.lineUuid);
  const out: Paragraph[] = [];
  if (request)
    out.push({
      text: `Request: ${request.number} | Aircraft: ${request.aircraftRegistration || "Stock"} | Allocated: ${a.quantity}`,
    });
  if (!item || !l.repairComponentUuid) return out;
  out.push(
    {
      text: `Repair service: ${l.repairWork} | Serial: ${item.componentSerial || "Not recorded"}`,
    },
    { text: `Defect: ${item.defect}` },
    { text: `Work requested: ${item.workRequested}` },
  );
  return out;
}
