import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: {
    // Production build that still offers the demo the specs sign in to,
    // served with the Cloudflare headers in public/_headers. The teardown
    // fails the run on any Content-Security-Policy violation.
    command:
      "VITE_ALLOW_DEMO=true npm run build && node scripts/serve-dist.mjs --report-csp --port 4173",
    timeout: 240000,
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  globalTeardown: "./tests/csp-report.ts",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
