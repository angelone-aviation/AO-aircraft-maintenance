/**
 * Responsibility: Pins saving vendors, the directory's merge of saved and typed
 *   vendor names, and its program scoping.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/vendors.ts, ./management, ./programs,
 *   ./purchaseOrders and ./partsRequests (types), src/data/demo.ts (seed).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement, vendorSchema, type Stock } from "./management";
import type { Address } from "./addresses";
import type { PartsRequest } from "./partsRequests";
import type { PurchaseOrder } from "./purchaseOrders";
import { vendorDirectory, vendorKey } from "./vendors";
import { scopedSnapshot } from "./programs";
const command = (name = "Aircraft supplier") => ({
  action: "record.save" as const,
  requestUuid: crypto.randomUUID(),
  reason: "Vendor added",
  record: vendorSchema.parse({
    kind: "vendor",
    uuid: crypto.randomUUID(),
    version: 0,
    name,
  }),
});
describe("vendor directory", () => {
  it("saves name-only vendors, rejects duplicate names, and checks stale edits", () => {
    const s = demoSnapshot();
    s.user.isAdmin = true;
    const c = command();
    applyManagement(s, c);
    const saved = vendorDirectory(s).find((v) => v.name === c.record.name)!;
    expect(saved.version).toBe(1);
    expect(saved.addressDetails).toBeUndefined();
    expect(() => applyManagement(s, command("  AIRCRAFT SUPPLIER  "))).toThrow(
      /already exists/,
    );
    applyManagement(s, {
      ...command(),
      record: { ...saved, notes: "Account contact updated" },
    });
    expect(() =>
      applyManagement(s, {
        ...command(),
        record: { ...saved, notes: "Stale update" },
      }),
    ).toThrow();
  });
  it("requires inventory administrator access and hides vendors from other programs", () => {
    const s = demoSnapshot();
    s.user.isAdmin = true;
    applyManagement(s, command());
    const saved = vendorDirectory(s).find(
      (v) => v.name === "Aircraft supplier",
    )!;
    s.management!.push({
      ...saved,
      uuid: "foreign",
      name: "Foreign supplier",
      programUuid: "other-program",
    });
    expect(
      vendorDirectory(scopedSnapshot(s)).some(
        (v) => v.name === "Foreign supplier",
      ),
    ).toBe(false);
    s.user.isAdmin = false;
    s.user.groupIds = [];
    expect(() => applyManagement(s, command("Forbidden"))).toThrow(
      /Permission/,
    );
  });
  it("adds names typed elsewhere once, a saved vendor winning", () => {
    const s = demoSnapshot();
    s.user.isAdmin = true;
    applyManagement(s, command("Acme"));
    const order = (vendor: string, updatedAt: number, contact: string) =>
      ({ vendor, updatedAt, vendorContact: contact }) as PurchaseOrder;
    s.purchaseOrders = [
      order("  ACME ", 3, "PO contact"),
      order("Blue Sky Parts", 1, "Older contact"),
      order(" Blue sky parts ", 2, "Newest contact"),
      order("  ", 4, ""),
    ];
    s.purchaseOrders.push({
      ...order("Delta Avionics", 5, "Delta Avionics, Main St"),
      vendorAddressDetails: { street: "Main St" } as Address,
    });
    s.partsRequests = [{ vendor: "Zulu Supply" } as PartsRequest];
    s.management!.push({ kind: "stock", vendor: "Zulu supply" } as Stock);
    expect(vendorKey("  Blue SKY parts ")).toBe("blue sky parts");
    const directory = vendorDirectory(s);
    expect(directory.map((v) => [v.name, v.uuid !== "", v.notes])).toEqual([
      ["Acme", true, ""],
      ["Blue sky parts", false, "Newest contact"],
      ["Delta Avionics", false, ""],
      ["Zulu Supply", false, ""],
    ]);
    expect(directory[1]).toMatchObject({ version: 0, uuid: "" });
  });
});
