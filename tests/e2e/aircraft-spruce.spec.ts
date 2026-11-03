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
      name: "Link Aircraft Spruce account",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Link accounts in the connected app. Demo mode does not store credentials.",
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Aircraft Spruce password", { exact: true }),
  ).toHaveCount(0);
});
