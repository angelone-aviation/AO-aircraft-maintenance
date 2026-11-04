/**
 * Responsibility: Checks an uploaded manual PDF and searches its pages for
 *   inspection and component-limit suggestions.
 * Layer: Data. Browser-only PDF.js access; no React.
 * Dependencies: src/data/pdfRuntime.ts, src/data/pdfText.ts,
 *   src/domain/manuals.ts, src/domain/manualDiscovery.ts.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { getDocument } from "./pdfRuntime";
import { readPdfText } from "./pdfText";
import { validateManualFile } from "../domain/manuals";
import type { ManualCandidate } from "../domain/manualDiscovery";

// A vertical jump larger than this (PDF units) starts a new line of text.
const LINE_BREAK_RISE = 3;
// Fewer characters than this mean a scanned or blank page to review by eye.
const MIN_PAGE_TEXT = 30;

type LoadingTask = ReturnType<typeof getDocument>;

/**
 * Opens an uploaded manual to count its pages.
 *
 * @param file - The uploaded PDF.
 * @returns Its page count.
 * @throws {Error} As `validateManualFile` for a file that is not a PDF up to
 *   200 MB; "Upload a PDF that opens without a password." for an encrypted
 *   one; PDF.js's error for an unreadable one.
 */
export async function inspectManualPdf(file: File) {
  validateManualFile(file);
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
  });
  try {
    return (
      await openWithoutPassword(
        task,
        "Upload a PDF that opens without a password.",
      )
    ).numPages;
  } finally {
    await task.destroy();
  }
}

/**
 * Reads a page range of a manual and reports each page's suggestions as it
 * goes, yielding between pages so progress and Cancel stay responsive.
 *
 * @param url - Where to load the PDF from.
 * @param manualUuid - The manual the suggestions will reference.
 * @param fromPage - First PDF page to read, from 1.
 * @param toPage - Last PDF page to read, at most the page count.
 * @param onProgress - Called after each page with its suggestions.
 * @param signal - Cancels the search. It also destroys the document, so a
 *   page being read rejects with PDF.js's error.
 * @returns How many pages had text, and the pages with too little to search
 *   (scanned or blank), in page order.
 * @throws {DOMException} AbortError "Search canceled" between pages.
 * @throws {Error} "This PDF requires a password."; "Choose a valid PDF page
 *   range." unless 1 ≤ fromPage ≤ toPage ≤ page count, all integers.
 */
export async function searchManualPdf(
  url: string,
  manualUuid: string,
  fromPage: number,
  toPage: number,
  onProgress: (page: number, candidates: ManualCandidate[]) => void,
  signal: AbortSignal,
) {
  const { discoverPage } = await import("../domain/manualDiscovery");
  const task = getDocument({ url, useSystemFonts: true });
  const abort = () => {
    void task.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(signal);
    const pdf = await openWithoutPassword(
      task,
      "This PDF requires a password.",
    );
    assertPageRange(fromPage, toPage, pdf.numPages);
    return await readPages(pdf, fromPage, toPage, signal, (n, text) =>
      onProgress(n, discoverPage(manualUuid, n, text)),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
}

// PDF.js asks for a password through a callback rather than rejecting, so
// race the load against a refusal raised from that callback.
function openWithoutPassword(task: LoadingTask, message: string) {
  const password = new Promise<never>((_, reject) => {
    task.onPassword = () => reject(new Error(message));
  });
  return Promise.race([task.promise, password]);
}

async function readPages(
  pdf: PDFDocumentProxy,
  fromPage: number,
  toPage: number,
  signal: AbortSignal,
  onPage: (page: number, text: string) => void,
) {
  let textPages = 0;
  const emptyPages: number[] = [];
  for (let n = fromPage; n <= toPage; n++) {
    throwIfAborted(signal);
    const page = await pdf.getPage(n);
    const text = joinPageText(await readPdfText(page));
    if (text.trim().length < MIN_PAGE_TEXT) emptyPages.push(n);
    else textPages++;
    onPage(n, text);
    page.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { textPages, emptyPages };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Search canceled", "AbortError");
}

function assertPageRange(from: number, to: number, pageCount: number): void {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to > pageCount ||
    from > to
  )
    throw new Error("Choose a valid PDF page range.");
}

function joinPageText(content: TextContent): string {
  let text = "";
  let previousY: number | undefined;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const y = item.transform[5];
    if (
      previousY !== undefined &&
      Math.abs(previousY - y) > LINE_BREAK_RISE &&
      !text.endsWith("\n")
    )
      text += "\n";
    text += item.str + (item.hasEOL ? "\n" : " ");
    previousY = y;
  }
  return text;
}
