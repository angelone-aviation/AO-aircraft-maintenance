/**
 * Responsibility: Pins the Overview's charts: hours flown by week once a
 *   flight is accepted, fleet readiness by status, and an aircraft's hours
 *   by month in its detail, each with its accessible name and text table.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const WEEKLY = "Hours flown by week, last 8 weeks";
const READINESS = "Fleet readiness: aircraft by status";

test("charts the hours of an accepted flight and the fleet's readiness", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openDemo(page);
  await expect(
    page.getByText("No accepted flights in the last 8 weeks."),
  ).toBeVisible();
  await expect(page.getByRole("figure", { name: WEEKLY })).toHaveCount(0);

  // N206MA starts at 2,341.2 h on the Hobbs: a 1.3 hour flight, today.
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await page.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.5");
  await page.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Log a flight" }),
  ).not.toBeVisible();

  const weekly = page.getByRole("figure", { name: WEEKLY });
  await expect(weekly.locator(".recharts-surface")).toBeVisible();
  const thisWeek = weekly.getByRole("row").last();
  await expect(thisWeek).toContainText("1.3 h");
  await expect(
    weekly.getByRole("columnheader", { name: "N206MA" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("article", { name: "N206MA" }).getByText("This week"),
  ).toBeVisible();

  const readiness = page.getByRole("figure", { name: READINESS });
  await expect(readiness.locator(".recharts-surface")).toBeVisible();
  await expect(readiness).toContainText("of 3 OK to fly");
  await expect(readiness).toContainText("Setup incomplete");

  await page
    .getByRole("article", { name: "N206MA" })
    .getByRole("button", { name: /View aircraft/ })
    .click();
  const monthly = page
    .getByRole("dialog", { name: "N206MA" })
    .getByRole("figure", {
      name: "N206MA hours flown by month, last 6 months",
    });
  await expect(monthly.locator(".recharts-surface")).toBeVisible();
  await expect(monthly.getByRole("row").last()).toContainText("1.3 h");
});

test("a phone keeps the hours card and leaves out the readiness donut", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openDemo(page);
  await expect(
    page.getByRole("heading", { name: "Hours flown", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("figure", { name: READINESS })).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);
});

async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}
