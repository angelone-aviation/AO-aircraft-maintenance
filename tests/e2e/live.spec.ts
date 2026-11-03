import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
const accountFile = ".env.local-admin.json";
const account: { email: string; password: string } | null = existsSync(
  accountFile,
)
  ? JSON.parse(readFileSync(accountFile, "utf8"))
  : null;
test.skip(
  !account,
  "Run npm run dev:local and npm run test:local to provision the local test administrator.",
);
async function login(page: Page) {
  await page.getByLabel("Email", { exact: true }).fill(account!.email);
  await page.getByLabel("Password", { exact: true }).fill(account!.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
}
test("real Convex login, offline reload and automatic discrepancy sync", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  const description = "Live offline test " + Date.now();
  await page.getByLabel("What did you observe?").fill(description);
  await page.getByRole("button", { name: "Save report" }).click();
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "1 pending entry" }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await expect(page.getByText(description, { exact: true })).toHaveCount(1);
});
test("offline logout clears cached access but retains entries for the original account", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Logout preservation " + Date.now());
  await page.getByRole("button", { name: "Save report" }).click();
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
  await login(page);
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible({ timeout: 20000 });
});
