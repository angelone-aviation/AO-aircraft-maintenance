/**
 * Responsibility: Pins the paragraph layout: page size, the embedded font,
 *   wrapping, the gap after each paragraph and when a new page starts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/pdfLayout.ts, tests/fixtures/pdfText.
 */
// @vitest-environment node
import { expect, it } from "vitest";
import { paragraphPdf, type Paragraph } from "./pdfLayout";
import { dejaVuFont, pdfLines } from "../../tests/fixtures/pdfText";

const A4_MM = { width: 210, height: 297 };
const POINTS_PER_MM = 72 / 25.4;
const TEXT_WIDTH_MM = 176;
const LINE_MM = 6;
const PARAGRAPH_GAP_MM = 2;
const font = dejaVuFont();
const pdf = (paragraphs: Paragraph[]) => paragraphPdf(paragraphs, font);

// The baseline of each line, in points from the page foot.
function baselines(output: string) {
  return [...output.matchAll(/ ([\d.]+) Td\n/g)].map((m) => Number(m[1]));
}

it("prints on A4 portrait pages", () => {
  const size = pdf([{ text: "x" }]).internal.pageSize;
  expect(size.getWidth()).toBeCloseTo(A4_MM.width, 1);
  expect(size.getHeight()).toBeCloseTo(A4_MM.height, 1);
});

// jsPDF lists its standard fonts in every document; the text uses one font,
// the embedded one, which the next test proves by reading the text back.
it("prints in one embedded font, bold paragraphs at 12 pt and others at 10 pt", () => {
  const output = pdf([
    { text: "Title", bold: true },
    { text: "Body" },
  ]).output();
  expect(output).toContain("/BaseFont /DejaVu");
  const used = [...output.matchAll(/\/(F\d+) (\d+) Tf/g)];
  expect(used.map((m) => m[2])).toEqual(["12", "10"]);
  expect(new Set(used.map((m) => m[1])).size).toBe(1);
});

it("prints text outside Latin-1 as entered and drops control characters", async () => {
  const doc = pdf([{ text: "Łódź ⅜ ≥ 10 kΩ №5\u0001\tend" }]);
  expect(await pdfLines(doc)).toEqual(["Łódź ⅜ ≥ 10 kΩ №5 end"]);
});

it("wraps a long paragraph at the text width and keeps its words in order", async () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
  const doc = pdf([{ text: words.join(" ") }]);
  const printed = await pdfLines(doc);
  expect(printed.length).toBeGreaterThan(1);
  expect(printed.join(" ")).toBe(words.join(" "));
  for (const text of printed)
    expect(doc.getTextWidth(text)).toBeLessThanOrEqual(TEXT_WIDTH_MM);
});

it("spaces lines 6 mm apart and paragraphs 2 mm more", () => {
  const output = pdf([{ text: "one\ntwo" }, { text: "three" }]).output();
  const [one, two, three] = baselines(output).map((y) => y / POINTS_PER_MM);
  expect(one - two).toBeCloseTo(LINE_MM, 5);
  expect(two - three).toBeCloseTo(LINE_MM + PARAGRAPH_GAP_MM, 5);
});

it("starts a new page once 33 one-line paragraphs fill one (Characterizes current behaviour)", () => {
  const pages = (count: number) =>
    pdf(
      Array.from({ length: count }, () => ({ text: "x" })),
    ).getNumberOfPages();
  expect(pages(33)).toBe(1);
  expect(pages(34)).toBe(2);
});
