/**
 * Responsibility: Pins the scanner's first render: the camera preview, the
 *   typed-code form, the Scan button and the Scan label page.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InventoryScanner.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { InventoryScanner, ScanButton, ScanPage } from "./InventoryScanner";

vi.mock("../data/store", () => ({
  useWorkspace: (select: (state: unknown) => unknown) =>
    select({ snapshot: { management: [] } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

it("starts with the camera preview beside the typed-code form", () => {
  const html = renderToStaticMarkup(h(InventoryScanner, {}));
  expect(html).toContain('data-state="idle"');
  expect(html).toContain("<video");
  expect(html).toContain("<strong>Camera preview</strong>");
  expect(html).toContain("Enter a label manually");
  expect(html).toContain('aria-label="Enter code manually"');
  expect(html).not.toContain('role="alert"');
});

it("shows only the Scan button until it is pressed", () => {
  const html = renderToStaticMarkup(h(ScanButton));
  expect(html).toMatch(
    /^<button type="button" class="button">.*Scan<\/button>$/,
  );
});

it("puts the scanner under the Scan label page header", () => {
  const html = renderToStaticMarkup(h(ScanPage));
  expect(html).toContain("Scan label");
  expect(html).toContain("inventory-scanner");
});
