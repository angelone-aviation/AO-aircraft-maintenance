/**
 * Responsibility: Pins the ATA chapter picker's field name, its Unassigned
 *   choice and its initial selection.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AtaChapterField.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AtaChapterField } from "./AtaChapterField";

vi.mock("../data/store", () => ({ useWorkspace: () => ({}) }));

it("submits as ataChapter, Unassigned as an empty value", () => {
  const html = renderToStaticMarkup(h(AtaChapterField, {}));
  expect(html).toContain('<select name="ataChapter"');
  expect(html).toContain('<option value="" selected="">Unassigned</option>');
  expect(html).toContain("<optgroup");
});

it("selects the initial chapter", () => {
  const html = renderToStaticMarkup(h(AtaChapterField, { initial: "21" }));
  expect(html).toContain('<option value="21" selected="">ATA 21:');
  expect(html).not.toContain('<option value="" selected="">');
});
