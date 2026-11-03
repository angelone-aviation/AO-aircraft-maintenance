/**
 * Responsibility: Pins the logbook PDF: lines per page, page-number footers,
 *   dropped control characters and the font-load error.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/logbookPdf.ts, pdfjs-dist,
 *   public/fonts/DejaVuSans.ttf (fixture).
 */
// @vitest-environment node
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { logbookPdf } from "./logbookPdf";

const LINES_PER_PAGE = 52;
let font: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
  const file = new URL("../../public/fonts/DejaVuSans.ttf", import.meta.url);
  font = new Uint8Array(await readFile(file));
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(font)),
  );
});
afterEach(() => vi.unstubAllGlobals());

const numberedLines = (count: number) =>
  Array.from({ length: count }, (_, i) => `Line ${i + 1}`);

async function pageTexts(text: string): Promise<string[][]> {
  const pdf = await logbookPdf(text);
  const task = getDocument({ data: new Uint8Array(pdf.output("arraybuffer")) });
  const doc = await task.promise;
  const pages: string[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const { items } = await (await doc.getPage(n)).getTextContent();
    pages.push(
      items.flatMap((item) => ("str" in item && item.str ? [item.str] : [])),
    );
  }
  await task.destroy();
  return pages;
}

it("fits 52 lines on a page and numbers every page", async () => {
  const lines = numberedLines(LINES_PER_PAGE + 1);
  expect(await pageTexts(lines.join("\n"))).toEqual([
    [...lines.slice(0, LINES_PER_PAGE), "Page 1 of 2"],
    [lines[LINES_PER_PAGE], "Page 2 of 2"],
  ]);
  expect(fetch).toHaveBeenCalledWith("/fonts/DejaVuSans.ttf");
  const onePage = numberedLines(LINES_PER_PAGE).join("\n");
  expect((await logbookPdf(onePage)).getNumberOfPages()).toBe(1);
});

it("wraps a line at the 174 mm text width", async () => {
  const phrase = "Replaced oil filter.";
  expect(await pageTexts(`${phrase} `.repeat(6))).toEqual([
    [Array(5).fill(phrase).join(" "), phrase, "Page 1 of 1"],
  ]);
});

it("drops carriage returns and control characters", async () => {
  expect(await pageTexts("A\u0001B\r\nC\u000bD\u001fE\rF")).toEqual([
    ["AB", "CDEF", "Page 1 of 1"],
  ]);
});

it("Characterizes current behaviour: jsPDF drops the rest of a line after a tab", async () => {
  expect(await pageTexts("Torque\t25 in-lb\nSafety wired")).toEqual([
    ["Torque", "Safety wired", "Page 1 of 1"],
  ]);
});

it("asks the user to reconnect when the font cannot be loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  await expect(logbookPdf("Entry")).rejects.toThrow(
    "Unable to load the PDF font. Reconnect and try again.",
  );
});
