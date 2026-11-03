import { jsPDF } from "jspdf";
import { localDate } from "../domain/model";
import {
  poStatus,
  poTotal,
  type PurchaseOrder,
} from "../domain/purchaseOrders";
export function poPdf(
  po: PurchaseOrder,
  snapshot?: import("../domain/model").Snapshot,
) {
  const doc = new jsPDF();
  let y = 18;
  const line = (value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10);
    for (const t of doc.splitTextToSize(value, 176)) {
      if (y > 275) {
        doc.addPage();
        y = 18;
      }
      doc.text(t, 17, y);
      y += 6;
    }
    y += 2;
  };
  const cash = (c: number) => `${po.currency} ${(c / 100).toFixed(2)}`;
  line(`PURCHASE ORDER ${po.number}`, true);
  line(
    `${poStatus(po)} | Revision ${po.revision} | ${localDate(po.issuedAt ?? po.createdAt)}`,
  );
  if (po.phase === "draft") line("DRAFT - NOT ISSUED", true);
  line(`Vendor: ${po.vendor}`, true);
  line(po.vendorContact);
  line(`Deliver to: ${po.shipTo}`);
  line(`Expected delivery: ${po.expectedDate || "Not specified"}`);
  for (const [i, l] of po.lines.entries()) {
    line(`${i + 1}. ${l.partNumber} - ${l.description}`, true);
    if (l.sprucePart)
      line(
        `Aircraft Spruce part: ${l.sprucePart.partNumber} | Order unit: ${l.sprucePart.uom || "Verify unit"}`,
      );
    line(
      `Qty: ${l.quantity} | Unit: ${cash(l.unitCents)} | Amount: ${cash(l.quantity * l.unitCents)}`,
    );
    for (const a of l.requestAllocations ?? []) {
      const request = snapshot?.partsRequests?.find(
        (r) => r.uuid === a.requestUuid,
      );
      const item = request?.lines.find((r) => r.uuid === a.lineUuid);
      if (request)
        line(
          `Request: ${request.number} | Aircraft: ${request.aircraftRegistration || "Stock"} | Allocated: ${a.quantity}`,
        );
      if (item && l.repairComponentUuid) {
        line(
          `Repair service: ${l.repairWork} | Serial: ${item.componentSerial || "Not recorded"}`,
        );
        line(`Defect: ${item.defect}`);
        line(`Work requested: ${item.workRequested}`);
      }
    }
    if (l.cancelled) line(`Cancelled quantity: ${l.cancelled}`);
    if (l.kind === "component")
      line(
        `Trackable component | ${l.componentType} | ${l.manufacturer} ${l.model}`,
      );
  }
  line(`Shipping: ${cash(po.shippingCents)}`);
  line(`Total ordered: ${cash(poTotal(po))}`, true);
  line(po.notes);
  return doc;
}
