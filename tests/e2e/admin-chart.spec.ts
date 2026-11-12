/**
 * Responsibility: Pins the Administration chart of active users by
 *   permission group: its accessible name, its data table, the drawn plot,
 *   and that a phone leaves it out.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const CHART = "Active users by permission group";

async function openAdmin(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
}

test("the Users tab charts active users by permission group", async ({
  page,
}) => {
  await openAdmin(page);
  const chart = page.getByRole("figure", { name: CHART, exact: true });
  await expect(chart).toBeVisible();
  // The demo's one pilot, Jordan Lee, is the only member of a group.
  const pilots = chart.getByRole("row", { name: /Pilots/ });
  await expect(pilots.getByRole("cell")).toHaveText("1");
  await expect(chart.locator(".recharts-surface")).toBeVisible();
  // The chart belongs to the Users tab only.
  await page
    .getByRole("group", { name: "Administration sections" })
    .getByRole("button", { name: "Aircraft", exact: true })
    .click();
  await expect(chart).toHaveCount(0);
});

test("a phone leaves the chart out and keeps each user's groups", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page);
  await expect(page.getByRole("figure", { name: CHART })).toBeHidden();
  await expect(
    page.locator(".list-row").filter({ hasText: "jordan@example.test" }),
  ).toContainText("Pilots");
});
