/**
 * Responsibility: Parts-request rules the requests screen applies: the
 *   statuses its filter lists, and turning selected requests into one
 *   purchase order draft.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./partsRequests, ./purchaseOrders, ./requiredParts,
 *   ./rejection; types from ./model and ./management.
 */
import {
  requestLineProgress,
  type PartsRequest,
  type RequestLine,
} from "./partsRequests";
import { poLineSchema, type PODraft } from "./purchaseOrders";
import { partsInventory, type PartsInventory } from "./requiredParts";
import { Rejection } from "./rejection";
import type { Snapshot } from "./model";
import type { ManagedRecord } from "./management";

/** Every status `requestStatus` reports, in the order a filter lists them. */
export const REQUEST_STATUSES = [
  "Recurring",
  "Requested",
  "Reserved",
  "On purchase order",
  "Out for repair",
  "Received / awaiting issue",
  "Partially issued",
  "Fulfilled",
  "Cancelled",
] as const;

// A location uuid that matches no location, so the PO editor makes the buyer
// choose one when no stock, component or location suggests it.
const UNCHOSEN_LOCATION = "choose-location";

type InventoryStock = PartsInventory["stock"][number];

/**
 * A purchase order draft for the selected requests: one line per request
 * line still to order, allocated to that line. Repair lines return their
 * component; part lines use matching stock.
 *
 * @param s - The snapshot holding the requests, stock and components.
 * @param ids - The selected request uuids; cancelled ones are skipped.
 * @returns A new draft (version 0) with the first request's vendor, currency,
 *   ship-to and required-by date. Its vendor and ship-to may be empty; the
 *   PO editor checks them on save.
 * @throws {Rejection} "Select an open request.", "Select occurrence requests
 *   for purchasing, not recurring lists.", "Select requests with the same
 *   vendor, currency and ship-to address." or "Selected requests are already
 *   reserved, ordered or fulfilled."
 */
export function requestPODraft(s: Snapshot, ids: string[]): PODraft {
  const requests = (s.partsRequests ?? []).filter(
    (r) => ids.includes(r.uuid) && !r.cancelled,
  );
  assertPurchasable(requests);
  const first = requests[0];
  const inventory = partsInventory(s);
  const lines = requests.flatMap((r) =>
    r.lines.flatMap((l) => requestPOLines(s, r, l, inventory)),
  );
  if (!lines.length)
    throw new Rejection(
      "Selected requests are already reserved, ordered or fulfilled.",
    );
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    vendor: first.vendor,
    vendorContact: first.vendorAddress,
    vendorAddressDetails: first.vendorAddressDetails,
    shippingAddress: first.shipToDetails,
    shipTo: first.shipTo,
    currency: first.currency,
    expectedDate: first.requiredBy,
    shippingCents: 0,
    notes: requests.map((r) => `${r.number}: ${r.notes}`).join("\n"),
    lines,
  };
}

// Purchasing works on occurrence requests that share one vendor, currency
// and ship-to, so they can become a single order.
function assertPurchasable(requests: PartsRequest[]) {
  if (!requests.length) throw new Rejection("Select an open request.");
  if (requests.some((r) => r.recurring))
    throw new Rejection(
      "Select occurrence requests for purchasing, not recurring lists.",
    );
  const first = requests[0];
  if (
    requests.some(
      (r) =>
        r.vendor.toLowerCase() !== first.vendor.toLowerCase() ||
        r.currency !== first.currency ||
        r.shipTo.trim() !== first.shipTo.trim(),
    )
  )
    throw new Rejection(
      "Select requests with the same vendor, currency and ship-to address.",
    );
}

// One PO line for what a request line still needs ordered, or none.
function requestPOLines(
  s: Snapshot,
  r: PartsRequest,
  l: RequestLine,
  inventory: PartsInventory,
) {
  const quantity = requestLineProgress(s, r, l.uuid).toOrder;
  if (!quantity) return [];
  const component = s.management?.find(
    (x) => x.kind === "component" && x.uuid === l.componentUuid,
  );
  const stock = inventory.stock.find((x) => x.partNumber === l.partNumber);
  const stockRecord = s.management?.find(
    (x) => x.uuid === stock?.uuid && x.kind === "stock",
  );
  const repair = r.mode === "repair";
  return [
    poLineSchema.parse({
      uuid: crypto.randomUUID(),
      stockUuid: r.mode === "parts" ? (stock?.uuid ?? "") : "",
      locationUuid: poLineLocation(stock, component, inventory),
      partNumber: l.partNumber,
      description: repair
        ? `${l.description} — ${l.service}: ${l.workRequested}`
        : l.description,
      quantity,
      unitCents: l.quotedCents,
      sprucePart: l.sprucePart,
      kind: lineKind(r, stockRecord),
      aircraftUuid: r.aircraftUuid,
      workOrderUuid: r.source.workOrderUuid,
      inspectionUuid: r.source.kind === "inspection" ? r.source.uuid : "",
      requestAllocations: [{ requestUuid: r.uuid, lineUuid: l.uuid, quantity }],
      ...(repair
        ? { repairComponentUuid: l.componentUuid, repairWork: l.service }
        : {}),
    }),
  ];
}

// Delivered to the part's stock lot, the repaired component's location, or
// the first inventory location.
function poLineLocation(
  stock: InventoryStock | undefined,
  component: ManagedRecord | undefined,
  inventory: PartsInventory,
) {
  return (
    stock?.locationUuid ||
    (component?.kind === "component" ? component.locationUuid : "") ||
    inventory.locations[0]?.uuid ||
    UNCHOSEN_LOCATION
  );
}

// A repair returns a tracked component; a part takes its stock's category.
function lineKind(r: PartsRequest, stock: ManagedRecord | undefined) {
  if (r.mode === "repair") return "component";
  return stock?.kind === "stock" ? stock.category : "part";
}
