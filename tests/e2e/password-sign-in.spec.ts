/**
 * Responsibility: Pins password as the only sign-in method: no Google or
 *   Microsoft buttons or address-borne sign-in notices, a Password block in
 *   My account and no sign-in methods dialog in Administration.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * Google and Microsoft sign-in were removed before launch (ADR-0015).
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };

test("the signed-out screen offers no Google or Microsoft sign-in", async ({
  page,
}) => {
  await page.goto("/?signInError=account&signInProvider=google");
  await expect(
    page.getByRole("button", { name: /Explore the local demo/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/Google|Microsoft/)).toHaveCount(0);
});

test("My account names the password as the way to sign in", async ({
  page,
}) => {
  await openDemo(page, "/settings#account");
  const account = page.getByRole("region", { name: "My account" });
  await expect(
    account.getByRole("heading", { level: 3, name: "Password", exact: true }),
  ).toBeVisible();
  await expect(
    account.getByText("You sign in with your email and password."),
  ).toBeVisible();
  await expect(account.getByText(/Google|Microsoft/)).toHaveCount(0);
});

test("Administration has no sign-in methods dialog, also on a phone", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openDemo(page, "/admin");
  const row = page
    .locator(".list-row")
    .filter({ hasText: "alex@example.test" });
  await expect(
    row.getByRole("button", { name: "Reset password", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign-in methods", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

async function openDemo(page: Page, path: string) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
}
