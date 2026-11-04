/**
 * Responsibility: Purchase-order rules the editor and list apply: field
 *   limits, the statuses and overdue rule, what an inspection still lacks,
 *   and how one edited draft becomes a draft per vendor.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./purchaseOrders, ./currencyCode, ./vendors, ./addresses,
 *   ./rejection; types from ./model and ./management.
 */
import {
  onOrder,
  outstanding,
  poDraftSchema,
  type PODraft,
  type POLine,
  type PurchaseOrder,
} from "./purchaseOrders";
import { vendorKey } from "./vendors";
import { formatAddress } from "./addresses";
import { Rejection } from "./rejection";
import type { Inspection, Snapshot } from "./model";
import type { Stock, Vendor } from "./management";

/** A currency code's length: three capital letters. */
export const CURRENCY_CODE_LENGTH = 3;

export { MAX_CORE_DUE_DAYS } from "./purchaseOrders";
export { CURRENCY_CODE_PATTERN } from "./currencyCode";

/** Every status `poStatus` reports, in the order a filter lists them. */
export const PO_STATUSES = [
  "Draft",
  "Issued",
  "Partially shipped",
  "Shipped",
  "Partially received",
  "Received",
  "Closed",
  "Cancelled",
] as const;

/**
 * An edited draft, ready to save, and what saving it draws on.
 *
 * `lineVendors` holds a vendor name chosen for single lines, by line uuid;
 * a blank one uses the draft's vendor. `target` is the uuid of an open draft
 * order to add the lines to, or "".
 */
export interface DraftSave {
  draft: PODraft;
  initial: PODraft;
  lineVendors: Record<string, string>;
  vendors: Vendor[];
  target: string;
  orders: PurchaseOrder[];
}

/**
 * Whether an order's delivery is overdue: issued, its expected date before
 * today, and units still to arrive.
 *
 * @param today - The local date, YYYY-MM-DD.
 */
export function deliveryOverdue(po: PurchaseOrder, today: string) {
  return (
    po.phase === "issued" &&
    !!po.expectedDate &&
    po.expectedDate < today &&
    po.lines.some((l) => outstanding(po, l) > 0)
  );
}

/**
 * What an inspection's required parts still lack once stock on hand, units
 * outstanding on issued orders and units on its own draft orders count.
 *
 * @returns One entry per required part whose stock lot exists, in list
 *   order; `quantity` is never below 0.
 */
export function inspectionShortfalls(
  s: Pick<Snapshot, "management" | "purchaseOrders">,
  inspection: Pick<Inspection, "uuid" | "requiredParts">,
): { stock: Stock; quantity: number }[] {
  return (inspection.requiredParts ?? []).flatMap((r) => {
    const stock = s.management?.find(
      (x) => x.kind === "stock" && x.uuid === r.stockUuid,
    );
    if (stock?.kind !== "stock") return [];
    const quantity =
      r.quantity -
      stock.quantity -
      onOrder(s, stock.uuid) -
      plannedForInspection(s, inspection.uuid, stock.uuid);
    return [{ stock, quantity: Math.max(0, quantity) }];
  });
}

/**
 * The drafts a save writes: the lines with a quantity, one draft per vendor,
 * or added to the chosen open draft.
 *
 * @returns Without a target, a draft per vendor in first-line order: the
 *   first keeps the draft's uuid, the next take "<uuid>-1", "<uuid>-2", and
 *   with several vendors each ships at zero cost. With one, that draft with
 *   the lines added.
 * @throws {Rejection} In order: "Select at least one part quantity to
 *   purchase.", "A saved PO must stay with one vendor.", "Select a vendor for
 *   each part.", "Add vendor “<name>” using Quick add or Add vendor before
 *   saving.", "Set shipping cost to zero here, then enter each vendor’s
 *   shipping charge on its separate draft PO.", then for a target "An
 *   existing draft must match the selected vendor.", "Ship-to must match the
 *   existing draft." or "Currency must match the existing draft."
 * @throws {z.ZodError} When a resulting draft breaks poDraftSchema.
 */
export function draftsToSave(save: DraftSave): PODraft[] {
  const { draft, initial, lineVendors } = save;
  const positive = draft.lines.filter((l) => l.quantity > 0);
  if (!positive.length)
    throw new Rejection("Select at least one part quantity to purchase.");
  if (initial.version && Object.values(lineVendors).some(Boolean))
    throw new Rejection("A saved PO must stay with one vendor.");
  const grouped = groupByVendor(save, positive);
  // One shipping charge cannot be divided between vendors' orders.
  if (grouped.size > 1 && draft.shippingCents > 0)
    throw new Rejection(
      "Set shipping cost to zero here, then enter each vendor’s shipping charge on its separate draft PO.",
    );
  if (save.target) return [addToExisting(save, grouped, positive)];
  return [...grouped.values()].map((group, index) =>
    vendorDraft(save, group, index, grouped.size),
  );
}

type VendorGroup = { vendor: Vendor; lines: POLine[] };

// Units of a stock lot already on this inspection's draft orders.
function plannedForInspection(
  s: Pick<Snapshot, "purchaseOrders">,
  inspectionUuid: string,
  stockUuid: string,
) {
  return (s.purchaseOrders ?? [])
    .filter((p) => p.phase === "draft")
    .flatMap((p) => p.lines)
    .filter(
      (l) => l.inspectionUuid === inspectionUuid && l.stockUuid === stockUuid,
    )
    .reduce((n, l) => n + l.quantity, 0);
}

// Keyed by vendorKey, in first-line order.
function groupByVendor(save: DraftSave, lines: POLine[]) {
  const grouped = new Map<string, VendorGroup>();
  for (const line of lines) {
    const name = (save.lineVendors[line.uuid] || save.draft.vendor).trim();
    if (!name) throw new Rejection("Select a vendor for each part.");
    const vendor = save.vendors.find(
      (v) => vendorKey(v.name) === vendorKey(name),
    );
    if (!vendor)
      throw new Rejection(
        `Add vendor “${name}” using Quick add or Add vendor before saving.`,
      );
    const group = grouped.get(vendorKey(name)) ?? { vendor, lines: [] };
    grouped.set(vendorKey(name), { ...group, lines: [...group.lines, line] });
  }
  return grouped;
}

function addToExisting(
  { draft, target, orders }: DraftSave,
  grouped: Map<string, VendorGroup>,
  lines: POLine[],
) {
  const existing = orders.find((p) => p.uuid === target && p.phase === "draft");
  if (
    !existing ||
    grouped.size !== 1 ||
    !grouped.has(existing.vendor.toLowerCase())
  )
    throw new Rejection("An existing draft must match the selected vendor.");
  if (existing.shipTo.trim() !== draft.shipTo.trim())
    throw new Rejection("Ship-to must match the existing draft.");
  if (existing.currency !== draft.currency)
    throw new Rejection("Currency must match the existing draft.");
  return poDraftSchema.parse({
    ...existing,
    lines: [...existing.lines, ...lines],
  });
}

function vendorDraft(
  { draft, initial }: DraftSave,
  { vendor, lines }: VendorGroup,
  index: number,
  vendorCount: number,
) {
  return poDraftSchema.parse({
    ...draft,
    uuid: index === 0 ? draft.uuid : `${draft.uuid}-${index}`,
    vendor: vendor.name,
    vendorUuid: vendor.uuid || undefined,
    lines,
    shippingCents: vendorCount > 1 ? 0 : draft.shippingCents,
    vendorContact: vendorContact(vendor, initial),
    vendorAddressDetails: vendor.addressDetails,
  });
}

// A directory address replaces the contact; otherwise a saved order keeps
// the contact typed for its own vendor.
function vendorContact(vendor: Vendor, initial: PODraft) {
  if (vendor.addressDetails) return formatAddress(vendor.addressDetails);
  return vendorKey(vendor.name) === vendorKey(initial.vendor)
    ? initial.vendorContact
    : "";
}
