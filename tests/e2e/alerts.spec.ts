/**
 * Responsibility: Pins the alerts screen: alerts grouped by severity, marking
 *   one or all read so it lasts across a reload, and opening an alert's screen.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";

test("alerts group by severity, mark read one at a time or all at once, and open their screen", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/alerts");
  await expect(
    page.getByRole("heading", { name: "What needs attention.", exact: true }),
  ).toBeVisible();
  const group = page.getByRole("region", { name: "Coming due", exact: true });
  await expect(group).toBeVisible();
  const markOne = group.getByRole("button", { name: /^Mark read: / });
  const unread = await markOne.count();
  expect(unread).toBeGreaterThan(1);
  await markOne.first().click();
  await expect(markOne).toHaveCount(unread - 1);
  await page.reload();
  await expect(markOne).toHaveCount(unread - 1);
  const markAll = page.getByRole("button", {
    name: "Mark all read",
    exact: true,
  });
  await markAll.click();
  await expect(markOne).toHaveCount(0);
  await expect(markAll).toBeDisabled();
  await page.reload();
  await expect(markOne).toHaveCount(0);
  await group.getByRole("link", { name: "Open", exact: true }).first().click();
  await expect(page).toHaveURL(/\/inspections$/);
  await expect(
    page.getByRole("heading", { name: "Inspections", exact: true }),
  ).toBeVisible();
});
