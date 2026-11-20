/**
 * Responsibility: Imports the planning app's ICAO flight-plan PDF: checks the
 *   upload, reads its one page's text and hands it to the ICAO parser.
 * Layer: Data. Browser file and PDF.js I/O; the field rules are in the domain.
 * Dependencies: src/data/pdfRuntime.ts, src/data/pdfText.ts,
 *   src/domain/pdf/icao.ts.
 */
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { getDocument } from "./pdfRuntime";
import { readPdfText } from "./pdfText";
import { parseIcao, type PdfText } from "../domain/pdf/icao";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
// The planning app's page box, in points. parseIcao's field boxes are measured
// on it, so text from any other page size is scaled to it first.
const TEMPLATE_WIDTH = 594.95996;
const TEMPLATE_HEIGHT = 841.91998;

/**
 * Imports a flight plan from the planning app's single-page ICAO PDF.
 *
 * @param file - The upload: named `*.pdf`, at most 10 MiB.
 * @param onStage - Called with each step's name as it starts, for reports.
 * @returns parseIcao's fields, plus `sourceName` (the file name) and
 *   `sourceHash` (hex SHA-256 of its bytes).
 * @throws {Error} "Choose a PDF smaller than 10 MiB.", "Upload the single-page
 *   ICAO flight-plan form.", or PDF.js's or parseIcao's errors. The PDF reader
 *   is closed either way.
 */
export async function readFlightPlanPdf(
  file: File,
  onStage: (stage: string) => void = () => {},
) {
  onStage("Validate file");
  if (!/\.pdf$/i.test(file.name) || file.size > MAX_PDF_BYTES)
    throw new Error("Choose a PDF smaller than 10 MiB.");
  onStage("Read file bytes");
  const data = await file.arrayBuffer();
  onStage("Calculate file fingerprint");
  const sourceHash = await sha256Hex(data);
  onStage("Create PDF reader");
  const task = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  });
  let plan;
  try {
    onStage("Open PDF");
    const pdf = await task.promise;
    if (pdf.numPages !== 1)
      throw new Error("Upload the single-page ICAO flight-plan form.");
    onStage("Read first page");
    const page = await pdf.getPage(1);
    onStage("Extract PDF text");
    const content = await readPdfText(page);
    onStage("Normalize PDF text coordinates");
    const items = scaleToTemplate(content, page.view);
    onStage("Parse flight-plan fields");
    plan = { ...parseIcao(items), sourceName: file.name, sourceHash };
  } catch (error) {
    // A failure to close must not hide why the import stopped.
    await task.destroy().catch(() => {});
    throw error;
  }
  onStage("Close PDF reader");
  await task.destroy();
  return plan;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function scaleToTemplate(
  { items }: TextContent,
  [x0, y0, x1, y1]: number[],
): PdfText[] {
  return items.flatMap((item) => {
    if (!("str" in item)) return [];
    const [, , , , x, y] = item.transform;
    return [
      {
        str: item.str,
        x: ((x - x0) * TEMPLATE_WIDTH) / (x1 - x0),
        y: ((y - y0) * TEMPLATE_HEIGHT) / (y1 - y0),
      },
    ];
  });
}
