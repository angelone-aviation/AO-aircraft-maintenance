/**
 * Responsibility: Fails the browser-test run on any Content-Security-Policy
 *   violation that the test server collected.
 * Layer: Test. Playwright global teardown; never shipped in the build.
 * Dependencies: @playwright/test (types).
 *
 * scripts/serve-dist.mjs --report-csp collects the browser's reports. A
 * violation means a feature would break on the Cloudflare site, which sends
 * the same policy (public/_headers).
 */
import type { FullConfig } from "@playwright/test";

// Must match REPORT_PATH in scripts/serve-dist.mjs.
const REPORT_PATH = "/__csp-report";

/** The fields of a report-uri violation report that this check prints. */
interface ViolationReport {
  "effective-directive"?: string;
  "violated-directive"?: string;
  "blocked-uri"?: string;
  "document-uri"?: string;
  "source-file"?: string;
  "line-number"?: number;
}

/**
 * Fails the run if the test server collected any CSP violation. Skips, with a
 * warning, when the server is not running or is not the report collector.
 *
 * @param config - The run's config; the first project's baseURL is the server.
 * @throws {Error} "The production Content-Security-Policy (public/_headers) was
 *   violated <n> time(s):", then one line per distinct violation.
 */
export default async function checkContentSecurityPolicy(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  let response: Response;
  try {
    response = await fetch(new URL(REPORT_PATH, baseURL));
  } catch {
    console.warn("CSP check skipped: the test server is not running.");
    return;
  }
  if (response.headers.get("x-csp-report-collector") !== "1") {
    console.warn(
      "CSP check skipped: the test server is not scripts/serve-dist.mjs --report-csp.",
    );
    return;
  }
  const reports = (await response.json()) as ViolationReport[];
  if (!reports.length) return;
  const lines = [...new Set(reports.map(describeViolation))];
  throw new Error(
    `The production Content-Security-Policy (public/_headers) was violated ${reports.length} time(s):\n- ${lines.join("\n- ")}`,
  );
}

function describeViolation(report: ViolationReport): string {
  return [
    report["effective-directive"] ?? report["violated-directive"],
    `blocked ${String(report["blocked-uri"] || "inline")}`,
    `on ${String(report["document-uri"])}`,
    report["source-file"]
      ? `from ${String(report["source-file"])}:${String(report["line-number"])}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
