/**
 * Responsibility: The vendor directory: saved vendors plus vendor names typed
 *   on purchase orders, parts requests and stock; and one vendor's orders
 *   and what was ordered on them.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model (types), ./management (types), ./purchaseOrders.
 */
import type { Snapshot } from "./model";
import type { Vendor } from "./management";
import { poTotal, type PurchaseOrder } from "./purchaseOrders";

/** What was ordered from a vendor in one currency. */
export interface VendorSpend {
  currency: string;
  cents: number;
}

type VendorMention = Pick<Vendor, "name" | "addressDetails"> & {
  contact: string;
};

/** The key that matches vendor names: trimmed and case-insensitive. */
export const vendorKey = (name: string) => name.trim().toLowerCase();

/**
 * Lists every vendor the snapshot knows, one per {@link vendorKey}. A saved
 * vendor wins over a typed name; a name never saved appears as first found on
 * the newest purchase order, then parts requests, then stock, with uuid "".
 *
 * @param s - The snapshot; scope it first to leave out other programs.
 * @returns Vendors sorted by name.
 */
export function vendorDirectory(s: Snapshot): Vendor[] {
  const entries = new Map<string, Vendor>();
  for (const record of s.management ?? [])
    if (record.kind === "vendor") entries.set(vendorKey(record.name), record);
  for (const mention of vendorMentions(s)) {
    const key = vendorKey(mention.name);
    if (mention.name.trim() && !entries.has(key))
      entries.set(key, unsavedVendor(mention));
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A vendor's purchase orders, matched by {@link vendorKey}.
 *
 * @param orders - The orders to look in, such as a snapshot's with older
 *   pages joined.
 * @param name - The vendor's name.
 * @returns Newest first by creation, as the Purchase orders screen lists
 *   them.
 */
export function vendorOrders(
  orders: readonly PurchaseOrder[],
  name: string,
): PurchaseOrder[] {
  return orders
    .filter((p) => vendorKey(p.vendor) === vendorKey(name))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * What the given orders placed with their vendor: each issued or closed
 * order's total (its lines at their unit price, plus shipping), by currency.
 * A draft was never sent and a cancelled order bought nothing, so neither
 * counts.
 *
 * @param orders - The orders.
 * @returns One total per currency, in the order each currency first
 *   appears.
 */
export function orderedSpend(orders: readonly PurchaseOrder[]): VendorSpend[] {
  const spend = new Map<string, number>();
  for (const p of orders)
    if (p.phase === "issued" || p.phase === "closed")
      spend.set(p.currency, (spend.get(p.currency) ?? 0) + poTotal(p));
  return [...spend].map(([currency, cents]) => ({ currency, cents }));
}

function vendorMentions(s: Snapshot): VendorMention[] {
  return [
    ...(s.purchaseOrders ?? [])
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        name: p.vendor,
        addressDetails: p.vendorAddressDetails,
        contact: p.vendorContact,
      })),
    ...(s.partsRequests ?? []).map((r) => ({
      name: r.vendor,
      addressDetails: r.vendorAddressDetails,
      contact: "",
    })),
    ...(s.management ?? []).flatMap((r) =>
      r.kind === "stock" && r.vendor
        ? [{ name: r.vendor, addressDetails: undefined, contact: "" }]
        : [],
    ),
  ];
}

// With a structured address, a purchase order's contact text is that address
// formatted (purchaseOrders.ts), so notes would only repeat it.
function unsavedVendor(mention: VendorMention): Vendor {
  return {
    kind: "vendor",
    uuid: "",
    version: 0,
    name: mention.name.trim(),
    addressDetails: mention.addressDetails,
    website: "",
    accountNumber: "",
    paymentTerms: "",
    notes: mention.addressDetails ? "" : mention.contact,
  };
}
