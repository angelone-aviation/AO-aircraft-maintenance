export const flightPlanImporterVersion = "FP4";
export function flightPlanUploadReport(
  error: unknown,
  stage: string,
  file: Pick<File, "size" | "type">,
  browser: string,
  moduleUrl: string,
) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  // Report browser/code locations, never the PDF name, contents, or account data.
  const clean = (text: string) =>
    text.replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, "$1");
  return [
    `PDF importer: ${flightPlanImporterVersion}`,
    `Step: ${stage}`,
    `Error: ${clean(message)}`,
    `Browser: ${browser}`,
    `File bytes: ${file.size}; type: ${file.type || "not supplied"}`,
    `Page module: ${clean(moduleUrl)}`,
    `Stream async iterator: ${typeof ReadableStream !== "undefined" && typeof Reflect.get(ReadableStream.prototype, Symbol.asyncIterator) === "function"}`,
    clean(stack),
  ]
    .filter(Boolean)
    .join("\n");
}
