import type { FullConfig } from "@playwright/test";

type Report = Record<string, unknown>;

/**
 * Global teardown: fail the run if the browser reported any
 * Content-Security-Policy violation to scripts/serve-dist.mjs. A violation
 * means a feature would break on the Cloudflare site, which sends the same
 * policy (public/_headers).
 */
export default async function checkContentSecurityPolicy(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  let response: Response;
  try {
    response = await fetch(new URL("/__csp-report", baseURL));
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
  const reports = (await response.json()) as Report[];
  if (!reports.length) return;
  const lines = [
    ...new Set(
      reports.map((report) =>
        [
          report["effective-directive"] ?? report["violated-directive"],
          `blocked ${String(report["blocked-uri"] || "inline")}`,
          `on ${String(report["document-uri"])}`,
          report["source-file"]
            ? `from ${String(report["source-file"])}:${String(report["line-number"])}`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ),
  ];
  throw new Error(
    `The production Content-Security-Policy (public/_headers) was violated ${reports.length} time(s):\n- ${lines.join("\n- ")}`,
  );
}
