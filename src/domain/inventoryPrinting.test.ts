import { expect, it } from "vitest";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import {
  inventoryItemUrl,
  inventoryPrintBase,
  inventoryTagFields,
} from "./inventoryPrinting";
import { inventoryPrintDocument } from "../data/inventoryPrintDocument";

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
