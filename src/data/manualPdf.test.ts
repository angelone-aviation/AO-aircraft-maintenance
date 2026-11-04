/**
 * Responsibility: Pins the manual search: page text as discovery reads it,
 *   pages too empty to search, page-range refusals and cancelling.
 * Layer: Test. Runs PDF.js's legacy build under Node with @napi-rs/canvas.
 * Dependencies: src/data/manualPdf.ts, jspdf, pdfjs-dist.
 *
 * @vitest-environment node
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { jsPDF } from "jspdf";
import { beforeAll, expect, it, vi } from "vitest";

const pageTexts: string[] = [];
vi.mock("../domain/manualDiscovery", () => ({
  discoverPage: (_manual: string, page: number, text: string) => {
    pageTexts.push(text);
    return [{ page }];
  },
}));

let url: string;
let searchManualPdf: typeof import("./manualPdf").searchManualPdf;

beforeAll(async () => {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  ({ searchManualPdf } = await import("./manualPdf"));
  const { GlobalWorkerOptions } =
    await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  ).href;
  const pdf = new jsPDF();
  pdf.text("Chapter 5 Time Limits", 10, 10);
  pdf.text("and Maintenance Checks", 10, 11);
  pdf.text(["Inspect the engine mount.", "Replace hoses."], 10, 30);
  pdf.addPage();
  pdf.text("Figure 2", 10, 10);
  pdf.addPage();
  const file = join(await mkdtemp(join(tmpdir(), "manual-")), "manual.pdf");
  await writeFile(file, Buffer.from(pdf.output("arraybuffer")));
  url = pathToFileURL(file).href;
});

const search = (from: number, to: number) =>
  searchManualPdf(
    url,
    "manual",
    from,
    to,
    () => undefined,
    new AbortController().signal,
  );

it("reports each page and the pages with too little text to search", async () => {
  pageTexts.length = 0;
  const progress: unknown[] = [];
  const result = await searchManualPdf(
    url,
    "manual",
    1,
    3,
    (page, candidates) => progress.push([page, candidates]),
    new AbortController().signal,
  );
  expect(result).toEqual({ textPages: 1, emptyPages: [2, 3] });
  expect(progress).toEqual([
    [1, [{ page: 1 }]],
    [2, [{ page: 2 }]],
    [3, [{ page: 3 }]],
  ]);
  expect(pageTexts[0]).toBe(
    "Chapter 5 Time Limits and Maintenance Checks\nInspect the engine mount.\nReplace hoses. ",
  );
});

it("refuses a page range outside the document", async () => {
  for (const [from, to] of [
    [0, 1],
    [2, 1],
    [1, 4],
    [1.5, 2],
  ])
    await expect(search(from, to)).rejects.toThrow(
      "Choose a valid PDF page range.",
    );
});

it("stops between pages once cancelled", async () => {
  const controller = new AbortController();
  const read: number[] = [];
  const searching = searchManualPdf(
    url,
    "manual",
    1,
    3,
    (page) => {
      read.push(page);
      controller.abort();
    },
    controller.signal,
  );
  await expect(searching).rejects.toThrow("Search canceled");
  expect(read).toEqual([1]);
});
