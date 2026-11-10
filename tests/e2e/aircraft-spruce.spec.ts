/**
 * Responsibility: Pins the Aircraft Spruce account panel in demo mode: it
 *   explains the live connection and offers no way to save credentials.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";

test("program vendor settings explain the live connection and prevent saving credentials in demo mode", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  // The account panel moved from Vendors to Settings → Flight Program.
  await page.goto("/vendors");
  await page
    .getByRole("link", { name: "Open Flight Program settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings#program$/);
  await expect(
    page.getByRole("heading", { name: "Aircraft Spruce account", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Update Aircraft Spruce account",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page
      .locator("#program")
      .getByText(
        "Not available in the demo: keys and accounts are saved only on a live deployment.",
      ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Aircraft Spruce password", { exact: true }),
  ).toHaveCount(0);
});
