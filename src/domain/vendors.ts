import type { Snapshot } from "./model";
import type { Vendor } from "./management";
export const vendorKey = (name: string) => name.trim().toLowerCase();
export function vendorDirectory(s: Snapshot): Vendor[] {
  const entries = new Map<string, Vendor>();
  for (const record of s.management ?? []) {
    if (record.kind === "vendor") entries.set(vendorKey(record.name), record);
  }
  const legacy = [
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
  for (const v of legacy)
    if (v.name.trim() && !entries.has(vendorKey(v.name))) {
      entries.set(vendorKey(v.name), {
        kind: "vendor",
        uuid: "",
        version: 0,
        name: v.name.trim(),
        addressDetails: v.addressDetails,
        website: "",
        accountNumber: "",
        paymentTerms: "",
        notes: v.addressDetails ? "" : v.contact,
      });
    }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}
