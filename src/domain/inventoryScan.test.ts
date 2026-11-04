/**
 * Responsibility: Pins how scanned labels and typed codes resolve to stock
 *   and components, and the refusals users see.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/inventoryScan.ts, inventoryPrinting.ts,
 *   management.ts, rejection.ts; src/data/demo.ts (fixture).
 */
import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { componentSchema, type Stock } from "./management";
import { inventoryItemUrl } from "./inventoryPrinting";
import { parseInventoryCode, resolveInventoryCode } from "./inventoryScan";
import { Rejection } from "./rejection";

// A stored ALT-100 alternator in the demo program.
const component = (uuid: string, serial: string) =>
  componentSchema.parse({
    uuid,
    version: 1,
    programUuid: "demo-program",
    kind: "component",
    aircraftUuid: "",
    componentType: "Appliance",
    partNumber: "ALT-100",
    serial,
    manufacturer: "Acme",
    notes: "",
    trackTime: true,
    trackCycles: false,
    trackCalendar: false,
    installed: false,
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
  });

function fixture() {
  const s = demoSnapshot();
  const stock: Stock = {
    uuid: "stock-1",
    version: 1,
    programUuid: "demo-program",
    kind: "stock",
    partNumber: "MS28775-224",
    description: "O-ring",
    category: "part",
    condition: "new",
    locationUuid: "store",
    quantity: 5,
    minimum: 0,
    alternates: "",
  };
  s.management = [
    stock,
    component("comp-1", "SN-1"),
    component("comp-2", "SN-2"),
  ];
  return { s, stock };
}
it("resolves the URL printed on labels to its stock item or component", () => {
  const { s, stock } = fixture();
  const url = inventoryItemUrl(
    "https://ops.example.test",
    stock,
    "demo-program",
  );
  expect(resolveInventoryCode(s, url)).toEqual({
    kind: "stock",
    uuid: "stock-1",
  });
  expect(
    resolveInventoryCode(s, "https://other.example.test/inventory?item=comp-2"),
  ).toEqual({ kind: "component", uuid: "comp-2" });
});
it("accepts typed item ids, serial numbers and unique part numbers", () => {
  const { s } = fixture();
  expect(resolveInventoryCode(s, " comp-1 ").uuid).toBe("comp-1");
  expect(resolveInventoryCode(s, "sn-2")).toEqual({
    kind: "component",
    uuid: "comp-2",
  });
  expect(resolveInventoryCode(s, "ms28775-224").uuid).toBe("stock-1");
  expect(() => resolveInventoryCode(s, "ALT-100")).toThrow("2 items match");
});
it("explains unknown, foreign and malformed codes", () => {
  const { s } = fixture();
  expect(() => resolveInventoryCode(s, "")).toThrow("Scan a label");
  expect(() => resolveInventoryCode(s, "NOPE")).toThrow("No inventory item");
  expect(() => resolveInventoryCode(s, "https://example.test/wifi")).toThrow(
    "not an Angel One inventory label",
  );
  expect(() =>
    resolveInventoryCode(s, "https://ops.example.test/inventory?item=gone"),
  ).toThrow("not available to you");
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "p2", name: "Ferry ops" },
  ];
  expect(() =>
    resolveInventoryCode(
      s,
      "https://ops.example.test/inventory?item=x&program=p2",
    ),
  ).toThrow("belongs to Ferry ops");
  // A printed label never falls back to serial/part-number matching.
  expect(() =>
    resolveInventoryCode(s, "https://ops.example.test/inventory?item=SN-1"),
  ).toThrow("not available");
  expect(
    parseInventoryCode("https://a.test/inventory?item=1&program=p"),
  ).toEqual({
    code: "1",
    program: "p",
    label: true,
  });
});
it("only resolves stock for inventory administrators", () => {
  const { s } = fixture();
  s.user.isAdmin = false;
  expect(() => resolveInventoryCode(s, "stock-1")).toThrow("No inventory item");
  expect(resolveInventoryCode(s, "SN-1").uuid).toBe("comp-1");
});

const NOT_A_LABEL = "This QR code is not an Angel One inventory label.";

it("refuses as a Rejection, and names another program only when it knows it", () => {
  const { s } = fixture();
  const label = (program: string) =>
    `https://ops.example.test/inventory?item=gone&program=${program}`;
  s.programs!.push({ ...s.programs![0], uuid: "p2", name: "Ferry ops" });
  const unavailable =
    "This label’s item is not available to you in the active Flight Program.";
  for (const [raw, message] of [
    ["", "Scan a label or enter a code."],
    ["https://[bad", NOT_A_LABEL],
    ["https://ops.example.test/stock?item=comp-1", NOT_A_LABEL],
    ["https://ops.example.test/inventory", NOT_A_LABEL],
    [
      "ALT-100",
      "2 items match “ALT-100”. Enter the serial number, or search the inventory list.",
    ],
    ["NOPE", "No inventory item you can access matches “NOPE”."],
    [
      label("p2"),
      "This label belongs to Ferry ops. Switch to that Flight Program, then scan again.",
    ],
    [label("demo-program"), unavailable],
    [label("unknown"), unavailable],
  ]) {
    expect(() => resolveInventoryCode(s, raw)).toThrow(Rejection);
    expect(() => resolveInventoryCode(s, raw)).toThrow(Error(message));
  }
});
