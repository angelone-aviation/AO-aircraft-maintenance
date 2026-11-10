/**
 * Responsibility: Serves the bundled PDF font to code under test and reads a
 *   generated PDF back as the text lines a reader sees.
 * Layer: Test. Fixture for node-environment vitest suites.
 * Dependencies: vitest, pdfjs-dist, jspdf (types),
 *   public/fonts/DejaVuSans.ttf, src/data/tablePdf.ts (EmbeddedFont type).
 *
 * A document in an embedded font stores glyph ids, not readable strings, so
 * its text is checked through PDF.js as a viewer would extract it.
 */
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { jsPDF } from "jspdf";
import { vi } from "vitest";
import type { EmbeddedFont } from "../../src/data/tablePdf";

const FONT_URL = new URL("../../public/fonts/DejaVuSans.ttf", import.meta.url);

/**
 * The bundled DejaVu Sans as `loadDejaVuFont()` returns it.
 *
 * @returns The font, base64-encoded, under its file and family names.
 */
export function dejaVuFont(): EmbeddedFont {
  return {
    file: "DejaVuSans.ttf",
    name: "DejaVu",
    base64: readFileSync(FONT_URL).toString("base64"),
  };
}

/**
 * Makes `fetch` answer every request with the bundled font, as the site
 * serves it; undo with `vi.unstubAllGlobals()`.
 */
export function serveDejaVuFont(): void {
  const bytes = readFileSync(FONT_URL);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(bytes))),
  );
}

/**
 * Reads every page's text runs: jsPDF writes each wrapped line as one run.
 *
 * @param pdf - The generated document.
 * @returns The non-empty runs, pages in order.
 */
export async function pdfLines(pdf: jsPDF): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(pdf.output("arraybuffer")) });
  const doc = await task.promise;
  const lines: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const { items } = await (await doc.getPage(n)).getTextContent();
    for (const item of items)
      if ("str" in item && item.str) lines.push(item.str);
  }
  await task.destroy();
  return lines;
}
