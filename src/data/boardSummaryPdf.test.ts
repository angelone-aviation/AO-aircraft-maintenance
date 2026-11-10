/**
 * Responsibility: Pins the wording of each aircraft's line in the board
 *   summary PDF.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/boardSummaryPdf.ts, src/domain/boardSummary.ts,
 *   src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "./demo";
import { boardSummary } from "../domain/boardSummary";
import { boardSummaryParagraphs } from "./boardSummaryPdf";

it("counts open discrepancies in the singular and the plural", () => {
  const summary = boardSummary(demoSnapshot());
  const line = summary.aircraft[0];
  const text = (open: number) =>
    boardSummaryParagraphs({
      ...summary,
      aircraft: [{ ...line, openDiscrepancies: open }],
    }).find((p) => p.text.startsWith(line.aircraft.registration))?.text;
  expect(text(1)).toContain(" 1 open discrepancy");
  expect(text(1)).not.toContain("discrepancies");
  expect(text(0)).toContain(" 0 open discrepancies");
  expect(text(2)).toContain(" 2 open discrepancies");
});
