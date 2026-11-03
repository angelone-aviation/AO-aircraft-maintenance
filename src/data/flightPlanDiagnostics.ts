/**
 * Responsibility: Builds the report a user copies when a flight-plan PDF fails
 *   to import, so support can see which step failed in which browser.
 * Layer: Data. Pure text formatting; no I/O, no React.
 * Dependencies: None.
 *
 * The report never holds the PDF's name or contents or account data, and URLs
 * lose their query string and fragment, which can carry tokens.
 */

/** Importer build, shown on the Flight plans screen and in upload reports. */
export const flightPlanImporterVersion = "FP4";

/**
 * Describes a failed flight-plan import for troubleshooting.
 *
 * @param error - What the importer threw, of any type.
 * @param stage - Import step that was running.
 * @param file - The upload; only its size and MIME type are reported.
 * @param browser - User-agent string.
 * @param moduleUrl - URL of the page module that ran the import.
 * @returns "\n"-joined lines: importer, step, error message, browser, file,
 *   page module, stream support, then the stack if the error has one.
 */
export function flightPlanUploadReport(
  error: unknown,
  stage: string,
  file: Pick<File, "size" | "type">,
  browser: string,
  moduleUrl: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return [
    `PDF importer: ${flightPlanImporterVersion}`,
    `Step: ${stage}`,
    `Error: ${stripUrlQueries(message)}`,
    `Browser: ${browser}`,
    `File bytes: ${file.size}; type: ${file.type || "not supplied"}`,
    `Page module: ${stripUrlQueries(moduleUrl)}`,
    `Stream async iterator: ${hasStreamAsyncIterator()}`,
    stripUrlQueries(stack),
  ]
    .filter(Boolean)
    .join("\n");
}

// Safari 18.6 lacks it; PDF.js getTextContent() uses it, so pdfText.ts avoids
// that call.
function hasStreamAsyncIterator(): boolean {
  return (
    typeof ReadableStream !== "undefined" &&
    typeof Reflect.get(ReadableStream.prototype, Symbol.asyncIterator) ===
      "function"
  );
}

// Cuts from "?" or "#" to the next space or ")", so a stack frame's line and
// column after a query string go too.
function stripUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, "$1");
}
