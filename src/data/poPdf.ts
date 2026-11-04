/**
 * Responsibility: Prints a purchase order as a PDF to send to the vendor.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/domain/model.ts, src/domain/purchaseOrders.ts.
 */
import { jsPDF } from "jspdf";
import { localDate, type Snapshot } from "../domain/model";
import {
  poStatus,
  poTotal,
  type PurchaseOrder,
} from "../domain/purchaseOrders";

const MARGIN_MM = 17;
const TOP_MM = 18;
const TEXT_WIDTH_MM = 176;
const LAST_LINE_MM = 275;
const LINE_MM = 6;
const PARAGRAPH_GAP_MM = 2;
const BOLD_FONT_PT = 12;
const BODY_FONT_PT = 10;

type Page = { doc: jsPDF; y: number };
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
 * @returns The document, ready for `save()`.
 */
export function poPdf(po: PurchaseOrder, snapshot?: Snapshot) {
  const page: Page = { doc: new jsPDF(), y: TOP_MM };
  writeText(page, `PURCHASE ORDER ${po.number}`, true);
  writeText(
    page,
    `${poStatus(po)} | Revision ${po.revision} | ${localDate(po.issuedAt ?? po.createdAt)}`,
  );
  if (po.phase === "draft") writeText(page, "DRAFT - NOT ISSUED", true);
  writeText(page, `Vendor: ${po.vendor}`, true);
  writeText(page, po.vendorContact);
  writeText(page, `Deliver to: ${po.shipTo}`);
  writeText(page, `Expected delivery: ${po.expectedDate || "Not specified"}`);
  for (const [i, l] of po.lines.entries())
    writePOLine(page, po, i, l, snapshot);
  writeText(page, `Shipping: ${formatMoney(po, po.shippingCents)}`);
  writeText(page, `Total ordered: ${formatMoney(po, poTotal(po))}`, true);
  writeText(page, po.notes);
  return page.doc;
}

function formatMoney(po: PurchaseOrder, cents: number): string {
  return `${po.currency} ${(cents / 100).toFixed(2)}`;
}

function writePOLine(
  page: Page,
  po: PurchaseOrder,
  i: number,
  l: POLine,
  snapshot?: Snapshot,
): void {
  writeText(page, `${i + 1}. ${l.partNumber} - ${l.description}`, true);
  if (l.sprucePart)
    writeText(
      page,
      `Aircraft Spruce part: ${l.sprucePart.partNumber} | Order unit: ${l.sprucePart.uom || "Verify unit"}`,
    );
  writeText(
    page,
    `Qty: ${l.quantity} | Unit: ${formatMoney(po, l.unitCents)} | Amount: ${formatMoney(po, l.quantity * l.unitCents)}`,
  );
  for (const a of l.requestAllocations ?? [])
    writeAllocation(page, l, a, snapshot);
  if (l.cancelled) writeText(page, `Cancelled quantity: ${l.cancelled}`);
  if (l.kind === "component")
    writeText(
      page,
      `Trackable component | ${l.componentType} | ${l.manufacturer} ${l.model}`,
    );
}

// A repair line also carries the component and work from the request line.
function writeAllocation(
  page: Page,
  l: POLine,
  a: Allocation,
  snapshot?: Snapshot,
): void {
  const request = snapshot?.partsRequests?.find(
    (r) => r.uuid === a.requestUuid,
  );
  const item = request?.lines.find((r) => r.uuid === a.lineUuid);
  if (request)
    writeText(
      page,
      `Request: ${request.number} | Aircraft: ${request.aircraftRegistration || "Stock"} | Allocated: ${a.quantity}`,
    );
  if (!item || !l.repairComponentUuid) return;
  writeText(
    page,
    `Repair service: ${l.repairWork} | Serial: ${item.componentSerial || "Not recorded"}`,
  );
  writeText(page, `Defect: ${item.defect}`);
  writeText(page, `Work requested: ${item.workRequested}`);
}

function writeText(page: Page, value: string, bold = false): void {
  const { doc } = page;
  doc.setFont("helvetica", bold ? "bold" : "normal");
  doc.setFontSize(bold ? BOLD_FONT_PT : BODY_FONT_PT);
  for (const row of doc.splitTextToSize(value, TEXT_WIDTH_MM)) {
    if (page.y > LAST_LINE_MM) {
      doc.addPage();
      page.y = TOP_MM;
    }
    doc.text(row, MARGIN_MM, page.y);
    page.y += LINE_MM;
  }
  page.y += PARAGRAPH_GAP_MM;
}
