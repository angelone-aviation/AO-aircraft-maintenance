/**
 * Responsibility: Prints a parts request, repair order or packing slip as a
 *   PDF.
 * Layer: Data. Browser-side PDF document; no React.
 * Dependencies: src/data/pdfLayout.ts, src/domain/partsRequests.ts,
 *   src/domain/model.ts.
 */
import { paragraphPdf, type Paragraph } from "./pdfLayout";
import {
  requestPurchases,
  type PartsRequest,
  type RequestLine,
  type RequestPurchase,
} from "../domain/partsRequests";
import type { Snapshot } from "../domain/model";

const SECONDS_PER_HOUR = 3600;
const CENTS_PER_UNIT = 100;

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
  const purchases = (
    s.partsRequestPurchases ?? requestPurchases(s.purchaseOrders ?? [])
  ).filter((p) => p.requestUuid === r.uuid);
  const out = listDetails(r, kind, purchases);
  for (const l of r.lines) out.push(...listLineParagraphs(s, r, l, purchases));
  out.push({ text: `Notes: ${r.notes}` });
  if (r.mode === "repair")
    out.push(
      { text: `Shipping instructions: ${r.shippingInstructions}` },
      { text: `Return instructions: ${r.returnInstructions}` },
    );
  out.push({
    text: "Prepared / checked by: ____________________    Date: ______________",
  });
  return paragraphPdf(out);
}

function documentTitle(r: PartsRequest, kind: "request" | "packing"): string {
  if (kind === "packing") return "PACKING SLIP";
  return r.mode === "repair" ? "REPAIR ORDER / TAG" : "PARTS ORDER REQUEST";
}

function listDetails(
  r: PartsRequest,
  kind: "request" | "packing",
  purchases: RequestPurchase[],
): Paragraph[] {
  const required = r.requiredBy || r.timeframe || "Not specified";
  const orders = [...new Set(purchases.map((p) => p.number))].join(", ");
  const out: Paragraph[] = [
    { text: `${documentTitle(r, kind)} ${r.number}`, bold: true },
    {
      text: `Date: ${r.date} | Engineer: ${r.engineer} | Inventory location: ${r.base}`,
    },
    {
      text: `Aircraft: ${r.aircraftRegistration || "Stock"} | S/N: ${r.aircraftSerial} | ${r.aircraftModel} | Year: ${r.aircraftYear}`,
    },
    { text: `Source: ${r.sourceLabel}` },
    { text: `Priority: ${r.priority} | Required by: ${required}` },
    { text: `To / vendor: ${r.vendor || "Not assigned"}` },
  ];
  if (r.vendorAddress) out.push({ text: r.vendorAddress });
  if (kind === "packing")
    out.push({ text: `From: ${r.shipFrom}` }, { text: `Bill to: ${r.billTo}` });
  out.push(
    { text: `Deliver / return to: ${r.shipTo}` },
    { text: `Purchase orders: ${orders || "Not yet ordered"}` },
  );
  return out;
}

function listLineParagraphs(
  s: Snapshot,
  r: PartsRequest,
  l: RequestLine,
  purchases: RequestPurchase[],
): Paragraph[] {
  const out: Paragraph[] = [
    {
      text: `${l.partNumber} — ${l.description} | Qty ${l.quantity}`,
      bold: true,
    },
    {
      text: `Alternate P/N: ${l.alternateNumber || "None"} | IPC reference: ${l.ipcReference || "Not specified"}`,
    },
  ];
  if (r.mode === "repair") out.push(...listRepairDetails(r, l));
  for (const p of purchases.filter((p) => p.lineUuid === l.uuid)) {
    const buyer =
      (s.members ?? []).find((m) => m.id === p.purchasedBy)?.name ??
      p.purchasedBy;
    out.push({
      text: `${p.number} | Qty ${p.quantity} | Received ${p.received} | Purchased ${p.purchasedDate || "Pending"} by ${buyer}`,
    });
  }
  return out;
}

function listRepairDetails(r: PartsRequest, l: RequestLine): Paragraph[] {
  const tag = `${r.number}-${r.lines.indexOf(l) + 1}`;
  const cost = (l.quotedCents / CENTS_PER_UNIT).toFixed(2);
  return [
    {
      text: `Repair tag: ${tag} | Serial / batch: ${l.componentSerial || "Not recorded"}`,
    },
    {
      text: `TSN: ${formatHours(l.componentTSN)} h | TSO: ${formatHours(l.componentTSO)} h`,
    },
    { text: `Service: ${l.service} | Estimated cost: ${r.currency} ${cost}` },
    { text: `Defect: ${l.defect}` },
    { text: `Work requested: ${l.workRequested}` },
  ];
}

function formatHours(seconds: number | null | undefined): string {
  return seconds == null
    ? "Not recorded"
    : (seconds / SECONDS_PER_HOUR).toFixed(1);
}
