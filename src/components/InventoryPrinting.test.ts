/**
 * Responsibility: Pins which print buttons an inventory item offers.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InventoryPrinting.tsx, react-dom/server,
 *   tests/fixtures (parts and work-order component).
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { PrintableItem } from "../domain/inventoryPrinting";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { InventoryPrintButtons } from "./InventoryPrinting";

vi.mock("../data/store", () => ({ useWorkspace: () => ({}) }));

const render = (item: PrintableItem) =>
  renderToStaticMarkup(h(InventoryPrintButtons, { item }));

it("offers a tag and a label for a component", () => {
  const html = render(workOrderComponent() as PrintableItem);
  expect(html).toContain(">Print Tag</button>");
  expect(html).toContain(">Print Label</button>");
});

it("offers only a label for stock", () => {
  const stock = partsFixture().management!.find((r) => r.kind === "stock");
  const html = render(stock as PrintableItem);
  expect(html).not.toContain("Print Tag");
  expect(html).toContain(">Print Label</button>");
  expect(html).not.toContain("<dialog");
});
