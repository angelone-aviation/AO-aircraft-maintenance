/**
 * Responsibility: Loads the bundled DejaVu Sans font for embedding in a PDF.
 * Layer: Data. Browser-only: fetches from the site's public folder; no React.
 * Dependencies: src/data/tablePdf.ts (EmbeddedFont type),
 *   public/fonts/DejaVuSans.ttf.
 *
 * jsPDF's standard fonts only encode Windows-1252; records can hold any
 * character, so documents that print user text embed this font.
 */
import type { EmbeddedFont } from "./tablePdf";

const FONT_FILE = "DejaVuSans.ttf";
const FONT_NAME = "DejaVu";

// Spreading the whole font into String.fromCharCode would exceed the engine's
// argument limit.
const CHAR_CODE_CHUNK = 8192;

/**
 * Fetches DejaVu Sans from the site and encodes it for jsPDF.
 *
 * @returns The font as `{ file: "DejaVuSans.ttf", name: "DejaVu", base64 }`.
 * @throws {Error} "Unable to load the PDF font. Reconnect and try again." when
 *   the font request fails with an HTTP error; a network failure rejects with
 *   fetch's own error.
 */
export async function loadDejaVuFont(): Promise<EmbeddedFont> {
  const response = await fetch(`${import.meta.env.BASE_URL}fonts/${FONT_FILE}`);
  if (!response.ok)
    throw new Error("Unable to load the PDF font. Reconnect and try again.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHAR_CODE_CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHAR_CODE_CHUNK));
  return { file: FONT_FILE, name: FONT_NAME, base64: btoa(binary) };
}
