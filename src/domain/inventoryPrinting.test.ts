/**
 * Responsibility: Pins label addresses and their refusals, removal tag fields,
 *   and the printed label and tag documents.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/inventoryPrinting.ts, ./components, ./rejection,
 *   src/data/inventoryPrintDocument.ts, tests/fixtures.
 */
import { expect, it } from "vitest";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import {
  inventoryItemUrl,
  inventoryPrintBase,
  inventoryTagFields,
} from "./inventoryPrinting";
import { inventoryPrintDocument } from "../data/inventoryPrintDocument";
import type { ComponentMovement } from "./components";
import { Rejection } from "./rejection";

it("builds stable item-specific URLs and rejects addresses that cannot be used by phone scans", () => {
  const component = { ...workOrderComponent(), uuid: "component / & ? #" };
  const url = new URL(
    inventoryItemUrl("https://stock.example.test/", component, "program / 1"),
  );
  expect(url.pathname).toBe("/inventory");
  expect(url.searchParams.get("item")).toBe(component.uuid);
  expect(url.searchParams.get("program")).toBe("program / 1");
  expect(
    inventoryItemUrl(
      "https://stock.example.test",
      { ...component, installed: false },
      "program / 1",
    ),
  ).toBe(url.href);
  for (const input of [
    "",
    "javascript:alert(1)",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "https://user:secret@example.test",
    "https://example.test/?token=secret",
    "https://example.test/inventory",
  ])
    expect(() => inventoryPrintBase(input)).toThrow();
  expect(inventoryPrintBase("http://192.168.1.5:5173")).toBe(
    "http://192.168.1.5:5173",
  );
});
it("produces minimal labels and a distinct component tag without treating a printed tag as a certification", async () => {
  const s = partsFixture(),
    c = workOrderComponent();
  const stock = s.management!.find((r) => r.kind === "stock")!;
  if (stock.kind !== "stock") throw new Error("missing fixture");
  const label = await inventoryPrintDocument({
    item: stock,
    kind: "label",
    height: 1.25,
    url: inventoryItemUrl("https://stock.example.test", stock, "demo-program"),
  });
  expect(label).toContain("@page {size:2in 1.25in;margin:0}");
  expect(label).toContain("FILTER-1");
  expect(label).not.toContain("SERIAL NO.");
  expect(label).not.toContain(stock.description);
  expect(label).toContain("<svg");
  const tag = inventoryTagFields(s, c);
  expect(tag.condition).toBe("");
  expect(tag.mechanic).toBe("");
  const html = await inventoryPrintDocument({
    item: c,
    kind: "tag",
    height: 4,
    tag: { ...tag, reason: '<script>alert("x")</script>' },
  });
  expect(html).toContain("PARTS REMOVAL");
  expect(html).toContain("Signature");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Set QR website address");
  await expect(
    inventoryPrintDocument({ item: stock, kind: "tag", height: 4, tag }),
  ).rejects.toThrow("tracked components");
  await expect(
    inventoryPrintDocument({ item: c, kind: "label", height: 0 }),
  ).rejects.toThrow("length");
});
it.each([
  [
    "not-an-address",
    "Enter the shared app’s full website address, including https:// or http://.",
  ],
  [
    "ftp://example.test",
    "Use an HTTP or HTTPS app address without a sign-in token, query or fragment.",
  ],
  [
    "https://example.test/#token",
    "Use an HTTP or HTTPS app address without a sign-in token, query or fragment.",
  ],
  [
    "http://0.0.0.0:5173",
    "Use your shared website or network address. localhost cannot open this app from a phone.",
  ],
  [
    "http://app.localhost",
    "Use your shared website or network address. localhost cannot open this app from a phone.",
  ],
  [
    "https://example.test/inventory",
    "Enter the app’s base address only, without /inventory or another page path.",
  ],
])("refuses %s as a label address", (input, message) => {
  expect(() => inventoryPrintBase(input)).toThrow(Rejection);
  expect(() => inventoryPrintBase(input)).toThrow(message);
});
it("refuses a label address over 300 characters", () => {
  const item = workOrderComponent();
  const base = "https://example.test";
  const fits = inventoryItemUrl(base, item, "p");
  const padding = "p".repeat(300 - fits.length);
  expect(inventoryItemUrl(base, item, "p" + padding)).toHaveLength(300);
  const long = () => inventoryItemUrl(base, item, "pp" + padding);
  expect(long).toThrow(Rejection);
  expect(long).toThrow(
    "This address is too long for a small label. Use a shorter app address.",
  );
});
it("tags from the latest removal no correction superseded, and ignores blank incoming tag fields", () => {
  const s = partsFixture();
  const c = {
    ...workOrderComponent(),
    installed: false,
    incomingTag: { description: "", tagNumber: "T-1" },
  };
  expect(inventoryTagFields(s, c)).toMatchObject({
    description: c.componentType,
    tagNumber: "T-1",
  });
  const removal = (
    uuid: string,
    date: string,
    at: number,
  ): ComponentMovement => ({
    uuid,
    version: 1,
    kind: "componentMovement",
    componentUuid: c.uuid,
    aircraftUuid: s.aircraft[0].uuid,
    action: "REMOVE",
    date,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cycles: 0,
    serviceDays: 0,
    note: "Removed " + date,
    actorId: s.user.id,
    at,
  });
  s.management = [
    removal("first", "2026-01-01", 1),
    { ...removal("corrected", "2026-03-01", 3), supersededByCorrection: "x" },
    removal("latest", "2026-02-01", 2),
  ];
  expect(inventoryTagFields(s, c)).toMatchObject({
    removalDate: "2026-02-01",
    reason: "Removed 2026-02-01",
    tagNumber: "",
    lastOperator: s.aircraft[0].registration,
  });
});
