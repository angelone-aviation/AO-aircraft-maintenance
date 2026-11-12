/**
 * Responsibility: Pins the charts on the maintenance screens: the status
 *   share of the listed inspections and Planning's twelve-month workload,
 *   each with its accessible name, its numbers as text and a drawn plot.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * The demo holds four inspection schedules: two due soon and two scheduled.
 * It has no flights, so only its two annuals (due in 24 and 84 days) are
 * projected on Planning; both are inspections.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const WORKLOAD_MONTHS = 12;

test("Inspections shows how many listed schedules hold each status", async ({
  page,
}) => {
  await openDemo(page, "/inspections");
  const chart = page.getByRole("figure", {
    name: "Inspection schedules by status",
    exact: true,
  });
  await expect(chart).toContainText("4schedules");
  const legend = chart.getByRole("listitem");
  await expect(legend).toHaveText([
    /^Overdue0\s*0%$/,
    /^Due soon2\s*50%$/,
    /^Scheduled2\s*50%$/,
  ]);
  await expect(chart.locator(".recharts-surface")).toBeVisible();
  // Overdue is 0: listed above, but no sliver in the ring.
  await expect(chart.locator(".recharts-pie-sector")).toHaveCount(2);
  // On track is the accent, not the green of airworthy.
  await expect(legend.nth(2).locator(".ds-chart-swatch")).toHaveCSS(
    "background-color",
    "rgb(37, 99, 235)",
  );

  await page.getByLabel("Aircraft", { exact: true }).selectOption({
    label: "N208MA",
  });
  await expect(chart).toContainText("1schedule");
  await expect(legend.nth(2)).toHaveText(/^Scheduled1\s*100%$/);

  // Each row says its status, so a phone leaves the chart out.
  await page.setViewportSize(PHONE);
  await expect(chart).toBeHidden();
  await expect(
    page.getByRole("row").filter({ hasText: "Scheduled" }),
  ).toHaveCount(1);
});

test("Planning charts the items due in each of the next twelve months", async ({
  page,
}) => {
  await openDemo(page, "/planning");
  const chart = page.getByRole("figure", {
    name: "Items projected to fall due in each of the next 12 months",
    exact: true,
  });
  await expect(chart.locator(".recharts-surface")).toBeVisible();
  const rows = chart.getByRole("row");
  // A header row, then one row per month.
  await expect(rows).toHaveCount(WORKLOAD_MONTHS + 1);
  await expect(rows.first()).toHaveText(
    /^Month\s*Inspections\s*Component requirements\s*Airworthiness directives$/,
  );
  expect(await inspectionsDue(page)).toBe(2);

  await page.getByLabel("Aircraft", { exact: true }).selectOption({
    label: "N206MA",
  });
  expect(await inspectionsDue(page)).toBe(1);
  await page.getByLabel("Item type", { exact: true }).selectOption({
    label: "Airworthiness directives",
  });
  await expect(rows.first()).toHaveText(/^Month\s*Airworthiness directives$/);

  await page.setViewportSize(PHONE);
  await expect(chart).toBeVisible();
});

async function openDemo(page: Page, route: string) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(route);
}

// The total of the Inspections column of the chart's data table.
async function inspectionsDue(page: Page) {
  const cells = page
    .getByRole("figure", { name: /^Items projected to fall due/ })
    .locator("tbody tr td:nth-of-type(1)");
  await expect(cells).toHaveCount(WORKLOAD_MONTHS);
  const counts = await cells.allTextContents();
  return counts.reduce((sum, text) => sum + Number(text), 0);
}
