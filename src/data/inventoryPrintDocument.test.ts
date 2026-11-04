/**
 * Responsibility: Pins the label and tag length limits, the label QR size
 *   and the escaping of printed text.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/inventoryPrintDocument.ts, tests/fixtures.
 *
 * Tag content is pinned in src/domain/inventoryPrinting.test.ts.
 */
import { expect, it } from "vitest";
import { htmlEscape, inventoryPrintDocument } from "./inventoryPrintDocument";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { inventoryTagFields } from "../domain/inventoryPrinting";

const component = workOrderComponent();
const tag = inventoryTagFields(partsFixture(), component);

it("accepts labels of 1 to 6 inches and tags of 3.5 to 6", async () => {
  for (const height of [1, 6])
    await expect(
      inventoryPrintDocument({ item: component, kind: "label", height }),
    ).resolves.toContain(`@page {size:2in ${height}in;margin:0}`);
  for (const height of [0.99, 6.01, Number.NaN])
    await expect(
      inventoryPrintDocument({ item: component, kind: "label", height }),
    ).rejects.toThrow("Choose a label length between 1 and 6 inches.");
  await expect(
    inventoryPrintDocument({ item: component, kind: "tag", height: 3.5, tag }),
  ).resolves.toContain("PARTS REMOVAL");
  await expect(
    inventoryPrintDocument({ item: component, kind: "tag", height: 3.4, tag }),
  ).rejects.toThrow("Choose a tag length between 3.5 and 6 inches.");
  await expect(
    inventoryPrintDocument({ item: component, kind: "tag", height: 4 }),
  ).rejects.toThrow("Tags are available only for tracked components.");
});

it("shrinks a short label's QR code to fit inside the sheet padding", async () => {
  const html = await inventoryPrintDocument({
    item: component,
    kind: "label",
    height: 1,
  });
  expect(html).toContain(".label .qr{width:0.88in;height:0.88in;");
  expect(html).toContain('class="qr-placeholder"');
});

it("escapes the five HTML-significant characters", () => {
  expect(htmlEscape(`<a href="x">Tom's & co</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;",
  );
});
