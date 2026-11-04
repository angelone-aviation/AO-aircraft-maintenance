/**
 * Responsibility: Prints a parts request, repair order or packing slip as a
 *   PDF.
 * Layer: Data. Browser-side jsPDF rendering; no React.
 * Dependencies: jspdf, src/domain/partsRequests.ts, src/domain/model.ts.
 */
import { jsPDF } from "jspdf";
import {
  requestPurchases,
  type PartsRequest,
  type RequestLine,
  type RequestPurchase,
} from "../domain/partsRequests";
import type { Snapshot } from "../domain/model";

const MARGIN_MM = 17;
const TOP_MM = 18;
const TEXT_WIDTH_MM = 176;
const LAST_LINE_MM = 275;
const LINE_MM = 6;
const PARAGRAPH_GAP_MM = 2;
const BOLD_FONT_PT = 12;
const BODY_FONT_PT = 10;

type Page = { doc: jsPDF; y: number };

/**
 * Lays out a parts request for the vendor: its details, each line with the
 * purchases made against it, notes and a sign-off line. Repair requests also
 * print a tag, the component's times and the work for each line.
 *
 * @param r - The request.
 * @param s - Snapshot holding its purchases and the members who made them.
 * @param kind - "request" for the order; "packing" for a packing slip, which
 *   adds the ship-from and bill-to addresses.
 * @returns The document, ready for `save()`.
 */
export function requestPdf(
  r: PartsRequest,
  s: Snapshot,
  kind: "request" | "packing",
) {
  const page: Page = { doc: new jsPDF(), y: TOP_MM };
  const purchases = (
    s.partsRequestPurchases ?? requestPurchases(s.purchaseOrders ?? [])
  ).filter((p) => p.requestUuid === r.uuid);
  writeDetails(page, r, kind, purchases);
  for (const l of r.lines) writeRequestLine(page, s, r, l, purchases);
  writeText(page, `Notes: ${r.notes}`);
  if (r.mode === "repair") {
    writeText(page, `Shipping instructions: ${r.shippingInstructions}`);
    writeText(page, `Return instructions: ${r.returnInstructions}`);
  }
  writeText(
    page,
    "Prepared / checked by: ____________________    Date: ______________",
  );
  return page.doc;
}

function documentTitle(r: PartsRequest, kind: "request" | "packing"): string {
  if (kind === "packing") return "PACKING SLIP";
  return r.mode === "repair" ? "REPAIR ORDER / TAG" : "PARTS ORDER REQUEST";
}

function writeDetails(
  page: Page,
  r: PartsRequest,
  kind: "request" | "packing",
  purchases: RequestPurchase[],
): void {
  const required = r.requiredBy || r.timeframe || "Not specified";
  const orders = [...new Set(purchases.map((p) => p.number))].join(", ");
  writeText(page, `${documentTitle(r, kind)} ${r.number}`, true);
  writeText(
    page,
    `Date: ${r.date} | Engineer: ${r.engineer} | Inventory location: ${r.base}`,
  );
  writeText(
    page,
    `Aircraft: ${r.aircraftRegistration || "Stock"} | S/N: ${r.aircraftSerial} | ${r.aircraftModel} | Year: ${r.aircraftYear}`,
  );
  writeText(page, `Source: ${r.sourceLabel}`);
  writeText(page, `Priority: ${r.priority} | Required by: ${required}`);
  writeText(page, `To / vendor: ${r.vendor || "Not assigned"}`);
  if (r.vendorAddress) writeText(page, r.vendorAddress);
  if (kind === "packing") {
    writeText(page, `From: ${r.shipFrom}`);
    writeText(page, `Bill to: ${r.billTo}`);
  }
  writeText(page, `Deliver / return to: ${r.shipTo}`);
  writeText(page, `Purchase orders: ${orders || "Not yet ordered"}`);
}

function writeRequestLine(
  page: Page,
  s: Snapshot,
  r: PartsRequest,
  l: RequestLine,
  purchases: RequestPurchase[],
): void {
  writeText(
    page,
    `${l.partNumber} — ${l.description} | Qty ${l.quantity}`,
    true,
  );
  writeText(
    page,
    `Alternate P/N: ${l.alternateNumber || "None"} | IPC reference: ${l.ipcReference || "Not specified"}`,
  );
  if (r.mode === "repair") writeRepairDetails(page, r, l);
  for (const p of purchases.filter((p) => p.lineUuid === l.uuid)) {
    const buyer =
      (s.members ?? []).find((m) => m.id === p.purchasedBy)?.name ??
      p.purchasedBy;
    writeText(
      page,
      `${p.number} | Qty ${p.quantity} | Received ${p.received} | Purchased ${p.purchasedDate || "Pending"} by ${buyer}`,
    );
  }
}

function writeRepairDetails(page: Page, r: PartsRequest, l: RequestLine): void {
  const tag = `${r.number}-${r.lines.indexOf(l) + 1}`;
  const cost = (l.quotedCents / 100).toFixed(2);
  writeText(
    page,
    `Repair tag: ${tag} | Serial / batch: ${l.componentSerial || "Not recorded"}`,
  );
  writeText(
    page,
    `TSN: ${formatHours(l.componentTSN)} h | TSO: ${formatHours(l.componentTSO)} h`,
  );
  writeText(
    page,
    `Service: ${l.service} | Estimated cost: ${r.currency} ${cost}`,
  );
  writeText(page, `Defect: ${l.defect}`);
  writeText(page, `Work requested: ${l.workRequested}`);
}

function formatHours(seconds: number | null | undefined): string {
  return seconds == null ? "Not recorded" : (seconds / 3600).toFixed(1);
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
