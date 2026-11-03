import { jsPDF } from "jspdf";
import type { PartsRequest } from "../domain/partsRequests";
import { requestPurchases } from "../domain/partsRequests";
import type { Snapshot } from "../domain/model";
export function requestPdf(
  r: PartsRequest,
  s: Snapshot,
  kind: "request" | "packing",
) {
  const doc = new jsPDF();
  let y = 18;
  const text = (value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10);
    for (const row of doc.splitTextToSize(value || "—", 176)) {
      if (y > 275) {
        doc.addPage();
        y = 18;
      }
      doc.text(row, 17, y);
      y += 6;
    }
    y += 2;
  };
  text(
    `${kind === "packing" ? "PACKING SLIP" : r.mode === "repair" ? "REPAIR ORDER / TAG" : "PARTS ORDER REQUEST"} ${r.number}`,
    true,
  );
  text(
    `Date: ${r.date} | Engineer: ${r.engineer} | Inventory location: ${r.base}`,
  );
  text(
    `Aircraft: ${r.aircraftRegistration || "Stock"} | S/N: ${r.aircraftSerial} | ${r.aircraftModel} | Year: ${r.aircraftYear}`,
  );
  text(`Source: ${r.sourceLabel}`);
  text(
    `Priority: ${r.priority} | Required by: ${r.requiredBy || r.timeframe || "Not specified"}`,
  );
  text(`To / vendor: ${r.vendor || "Not assigned"}`);
  if (r.vendorAddress) text(r.vendorAddress);
  if (kind === "packing") {
    text(`From: ${r.shipFrom}`);
    text(`Bill to: ${r.billTo}`);
  }
  text(`Deliver / return to: ${r.shipTo}`);
  const purchases = (
    s.partsRequestPurchases ?? requestPurchases(s.purchaseOrders ?? [])
  ).filter((p) => p.requestUuid === r.uuid);
  text(
    `Purchase orders: ${[...new Set(purchases.map((p) => p.number))].join(", ") || "Not yet ordered"}`,
  );
  for (const l of r.lines) {
    text(`${l.partNumber} — ${l.description} | Qty ${l.quantity}`, true);
    text(
      `Alternate P/N: ${l.alternateNumber || "None"} | IPC reference: ${l.ipcReference || "Not specified"}`,
    );
    if (r.mode === "repair") {
      text(
        `Repair tag: ${r.number}-${r.lines.indexOf(l) + 1} | Serial / batch: ${l.componentSerial || "Not recorded"}`,
      );
      text(
        `TSN: ${l.componentTSN == null ? "Not recorded" : (l.componentTSN / 3600).toFixed(1)} h | TSO: ${l.componentTSO == null ? "Not recorded" : (l.componentTSO / 3600).toFixed(1)} h`,
      );
      text(
        `Service: ${l.service} | Estimated cost: ${r.currency} ${(l.quotedCents / 100).toFixed(2)}`,
      );
      text(`Defect: ${l.defect}`);
      text(`Work requested: ${l.workRequested}`);
    }
    for (const p of purchases.filter((p) => p.lineUuid === l.uuid))
      text(
        `${p.number} | Qty ${p.quantity} | Received ${p.received} | Purchased ${p.purchasedDate || "Pending"} by ${(s.members ?? []).find((m) => m.id === p.purchasedBy)?.name ?? p.purchasedBy}`,
      );
  }
  text(`Notes: ${r.notes}`);
  if (r.mode === "repair") {
    text(`Shipping instructions: ${r.shippingInstructions}`);
    text(`Return instructions: ${r.returnInstructions}`);
  }
  text("Prepared / checked by: ____________________    Date: ______________");
  return doc;
}
