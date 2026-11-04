/**
 * Responsibility: Pins the live app against a local Convex backend: password
 *   sign-in, an offline reload, a problem report synced on reconnect, and an
 *   offline sign-out that clears sign-in tokens but keeps the outbox.
 * Layer: Test. Playwright spec; skips itself without the local test account.
 * Dependencies: @playwright/test, node:fs.
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

// Written by npm run test:local when it provisions the local administrator.
const LOCAL_ADMIN_FILE = ".env.local-admin.json";
const OVERVIEW_HEADING = "Your fleet, at a glance.";
// Reconnecting, then flushing the outbox to Convex, outlasts the default wait.
const SYNC_TIMEOUT_MS = 20000;

const account: { email: string; password: string } | null = existsSync(
  LOCAL_ADMIN_FILE,
)
  ? JSON.parse(readFileSync(LOCAL_ADMIN_FILE, "utf8"))
  : null;
test.skip(
  !account,
  "Run npm run dev:local and npm run test:local to provision the local test administrator.",
);

test("real Convex login, offline reload and automatic discrepancy sync", async ({
  page,
  context,
}) => {
  await signInForOffline(page);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: OVERVIEW_HEADING }),
  ).toBeVisible();
  const description = "Live offline test " + Date.now();
  await reportProblem(page, description);
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "1 pending entry" }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible({ timeout: SYNC_TIMEOUT_MS });
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await expect(page.getByText(description, { exact: true })).toHaveCount(1);
});

test("offline logout clears cached access but retains entries for the original account", async ({
  page,
  context,
}) => {
  await signInForOffline(page);
  await context.setOffline(true);
  await reportProblem(page, "Logout preservation " + Date.now());
  // Sign-out reloads the page.
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((k) => k.startsWith("angel-one-auth:"))
          .length,
    ),
  ).toBe(0);
  await context.setOffline(false);
  // The outbox survives sign-out and syncs once the same account is back.
  await login(page);
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible({ timeout: SYNC_TIMEOUT_MS });
});

async function login(page: Page) {
  await page.getByLabel("Email", { exact: true }).fill(account!.email);
  await page.getByLabel("Password", { exact: true }).fill(account!.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
}

/**
 * Signs in and reloads once the service worker is ready, so the app shell is
 * cached for offline reloads.
 */
async function signInForOffline(page: Page) {
  await page.goto("/");
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: OVERVIEW_HEADING }),
  ).toBeVisible();
}

async function reportProblem(page: Page, description: string) {
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page.getByLabel("What did you observe?").fill(description);
  await page.getByRole("button", { name: "Save report" }).click();
}
