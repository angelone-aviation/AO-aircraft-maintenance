/**
 * Responsibility: Pins the Planning screen on the demo fleet: the horizon,
 *   aircraft and item-type filters, the stats they drive, and the CSV export
 *   of the items shown.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:fs/promises.
 *
 * The demo has no flights, so only its two annuals (due in 24 and 84 days)
 * are projected; its two 100-hour inspections have insufficient data.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const CSV_HEADER = [
  "Aircraft",
  "Type",
  "Item",
  "Description",
  "Projected date",
  "Basis",
  "Overdue",
  "Remaining",
  "Status",
  "Note",
];
// Excel reads a CSV as UTF-8 only after a byte-order mark.
const UTF8_BOM = "﻿";

test("filters the forecast, updates its stats and exports the shown items as CSV", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/planning");
  await expect(
    page.getByRole("heading", { name: "Planning", exact: true }),
  ).toBeVisible();
  await expectStats(page, { "Next 30 days": 1, Overdue: 0 });
  await expectStats(page, { "Aircraft affected": 1, "Insufficient data": 2 });
  const week = page.getByRole("list", { name: /^Week of / });
  await expect(week.getByRole("listitem")).toHaveCount(1);
  await expect(week).toContainText("N182MA · Inspection");
  const due = (await week.textContent())!.match(ISO_DATE)![0];
  await filter(page, "Horizon", "Next 90 days");
  await expectStats(page, { "Next 90 days": 2, "Aircraft affected": 2 });
  await filter(page, "Aircraft", "N206MA");
  await expectStats(page, { "Next 90 days": 1, "Insufficient data": 1 });
  await filter(page, "Item type", "Airworthiness directives");
  await expectStats(page, { "Next 90 days": 0, "Insufficient data": 0 });
  await expect(
    page.getByText("Nothing projected in the next 90 days", { exact: true }),
  ).toBeVisible();
  await expect(exportButton(page)).toBeDisabled();
  await filter(page, "Item type", "All items");
  await filter(page, "Aircraft", "N182MA");
  const csv = await exportCsv(page);
  expect(csv.name).toMatch(/^maintenance-forecast-\d{4}-\d{2}-\d{2}\.csv$/);
  // OD-8: the Status column carries the words the screen shows, not the
  // stored status code ("due-soon").
  expect(csv.lines).toEqual([
    UTF8_BOM + csvLine(CSV_HEADER),
    csvLine([
      "N182MA",
      "Inspection",
      "Annual inspection",
      "Calendar inspection",
      due,
      "Calendar",
      "",
      `due ${due}`,
      "Due soon",
      "No accepted flights recorded for this aircraft.",
    ]),
  ]);
});

async function filter(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).selectOption({ label: option });
}

/** Expects each named stat tile to show its value. */
async function expectStats(page: Page, stats: Record<string, number>) {
  for (const [label, value] of Object.entries(stats))
    await expect(statValue(page, label)).toHaveText(String(value));
}

function statValue(page: Page, label: string): Locator {
  return page
    .locator(".ds-stat-tile")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("strong");
}

function exportButton(page: Page): Locator {
  return page.getByRole("button", { name: "Export CSV", exact: true });
}

/** Exports the shown forecast; returns its file name and its CRLF lines. */
async function exportCsv(page: Page) {
  const downloading = page.waitForEvent("download");
  await exportButton(page).click();
  const download = await downloading;
  const text = await readFile((await download.path())!, "utf8");
  return { name: download.suggestedFilename(), lines: text.split("\r\n") };
}

// toCsv double-quotes every cell; none of these cells holds a quote.
function csvLine(cells: string[]) {
  return cells.map((cell) => `"${cell}"`).join(",");
}
