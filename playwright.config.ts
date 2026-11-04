/**
 * Responsibility: Runs the browser tests in tests/e2e against a production
 *   build served on a local port.
 * Layer: Config. Test runner only; the app and its build never load it.
 * Dependencies: @playwright/test, scripts/serve-dist.mjs, tests/csp-report.ts.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** One Chromium worker against the demo-enabled production build. */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  webServer: {
    // Production build that still offers the demo the specs sign in to,
    // served with the Cloudflare headers in public/_headers. The teardown
    // fails the run on any Content-Security-Policy violation.
    command: `VITE_ALLOW_DEMO=true npm run build && node scripts/serve-dist.mjs --report-csp --port ${PORT}`,
    timeout: 240000,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
  },
  globalTeardown: "./tests/csp-report.ts",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
