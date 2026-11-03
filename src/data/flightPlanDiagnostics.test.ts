import { expect, it } from "vitest";
import { flightPlanUploadReport } from "./flightPlanDiagnostics";
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
