/**
 * Responsibility: Pins the paragraph layout: page size, fonts, wrapping, the
 *   gap after each paragraph and when a new page starts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/pdfLayout.ts.
 */
// @vitest-environment node
import { expect, it } from "vitest";
import { paragraphPdf } from "./pdfLayout";

const A4_MM = { width: 210, height: 297 };
const POINTS_PER_MM = 72 / 25.4;
const TEXT_WIDTH_MM = 176;
const LINE_MM = 6;
const PARAGRAPH_GAP_MM = 2;

/** The text and baseline (in points from the page foot) of each line. */
function lines(output: string) {
  return [...output.matchAll(/ ([\d.]+) Td\n\((.*)\) Tj/g)].map((m) => ({
    y: Number(m[1]),
    text: m[2],
  }));
}

it("prints on A4 portrait pages", () => {
  const size = paragraphPdf([{ text: "x" }]).internal.pageSize;
  expect(size.getWidth()).toBeCloseTo(A4_MM.width, 1);
  expect(size.getHeight()).toBeCloseTo(A4_MM.height, 1);
});

it("prints bold paragraphs in 12 pt bold Helvetica and others in 10 pt", () => {
  const output = paragraphPdf([
    { text: "Title", bold: true },
    { text: "Body" },
  ]).output();
  expect(output).toMatch(/\/F2 12 Tf\n[^(]*\(Title\) Tj/);
  expect(output).toMatch(/\/F1 10 Tf\n[^(]*\(Body\) Tj/);
  expect(output).toContain("/BaseFont /Helvetica-Bold");
});

it("wraps a long paragraph at the text width and keeps its words in order", () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
  const doc = paragraphPdf([{ text: words.join(" ") }]);
  const printed = lines(doc.output());
  expect(printed.length).toBeGreaterThan(1);
  expect(printed.map((l) => l.text).join(" ")).toBe(words.join(" "));
  for (const { text } of printed)
    expect(doc.getTextWidth(text)).toBeLessThanOrEqual(TEXT_WIDTH_MM);
});

it("spaces lines 6 mm apart and paragraphs 2 mm more", () => {
  const output = paragraphPdf([
    { text: "one\ntwo" },
    { text: "three" },
  ]).output();
  const [one, two, three] = lines(output).map((l) => l.y / POINTS_PER_MM);
  expect(one - two).toBeCloseTo(LINE_MM, 5);
  expect(two - three).toBeCloseTo(LINE_MM + PARAGRAPH_GAP_MM, 5);
});

it("starts a new page once 33 one-line paragraphs fill one (Characterizes current behaviour)", () => {
  const page = (count: number) =>
    paragraphPdf(Array.from({ length: count }, () => ({ text: "x" })));
  expect(page(33).getNumberOfPages()).toBe(1);
  expect(page(34).getNumberOfPages()).toBe(2);
});
