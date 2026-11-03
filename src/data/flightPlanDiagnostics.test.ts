/**
 * Responsibility: Pins the flight-plan upload report: its lines, their order,
 *   and that it carries no URL tokens.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/flightPlanDiagnostics.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { flightPlanUploadReport } from "./flightPlanDiagnostics";
afterEach(() => vi.unstubAllGlobals());
it("reports the failing stage and code location without URL tokens or PDF metadata", () => {
  const error = new Error("undefined is not a function");
  error.stack =
    "at read (https://example.test/assets/pdf.js?token=private#fragment:1:2)";
  const report = flightPlanUploadReport(
    error,
    "Extract PDF text",
    { size: 123, type: "application/pdf" },
    "Safari test",
    "https://example.test/assets/FlightPlans.js?secret=private",
  );
  expect(report).toContain("PDF importer: FP4");
  expect(report).toContain("Step: Extract PDF text");
  expect(report).toContain("undefined is not a function");
  expect(report).toContain("https://example.test/assets/pdf.js");
  expect(report).not.toContain("private");
  expect(report).not.toContain("token=");
});
it("lists the lines in order and leaves out a missing stack", () => {
  vi.stubGlobal(
    "ReadableStream",
    class {
      [Symbol.asyncIterator]() {}
    },
  );
  const report = flightPlanUploadReport(
    "Fetch failed for https://example.test/worker.js#key",
    "Load PDF importer",
    { size: 0, type: "" },
    "Firefox test",
    "https://example.test/assets/FlightPlans.js",
  );
  expect(report).toBe(
    [
      "PDF importer: FP4",
      "Step: Load PDF importer",
      "Error: Fetch failed for https://example.test/worker.js",
      "Browser: Firefox test",
      "File bytes: 0; type: not supplied",
      "Page module: https://example.test/assets/FlightPlans.js",
      "Stream async iterator: true",
    ].join("\n"),
  );
});
it.each([
  ["no ReadableStream", undefined],
  ["streams that are not async iterable", class {}],
])("reports no stream async iterator for %s", (_, stream) => {
  vi.stubGlobal("ReadableStream", stream);
  const report = flightPlanUploadReport(
    "x",
    "s",
    { size: 1, type: "" },
    "",
    "",
  );
  expect(report).toContain("Stream async iterator: false");
});
it("Characterizes current behaviour: a frame's line and column after a query string are dropped", () => {
  const error = new Error("boom");
  error.stack =
    "at f (https://example.test/x.js?v=1:10:5)\nat g (https://example.test/y.js:3:4)";
  const report = flightPlanUploadReport(
    error,
    "s",
    { size: 1, type: "" },
    "",
    "",
  );
  expect(report).toContain(
    "at f (https://example.test/x.js)\nat g (https://example.test/y.js:3:4)",
  );
});
