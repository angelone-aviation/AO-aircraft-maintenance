/**
 * Responsibility: Pins the Weekly summary tab of Change history in the demo:
 *   a change made in the session is counted for its author, the period
 *   switches, refused sign-ins are not claimed as 0 inside a program, and
 *   the table exports as CSV.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:fs.
 */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("weekly summary counts the session's changes by person and exports CSV", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/discrepancies");
  await page
    .getByRole("button", { name: "Report a problem", exact: true })
    .click();
  await page
    .getByLabel("What did you observe?", { exact: true })
    .fill("Summary test: cabin door seal worn");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Save|Report/ })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await page.getByRole("link", { name: "Change history", exact: true }).click();
  await page.getByRole("button", { name: "Weekly summary" }).click();
  const table = page.getByRole("table", { name: "Changes by person" });
  await expect(table).toBeVisible();
  const row = table.getByRole("row", { name: /Alex Morgan/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell").last()).toHaveText(/^[1-9]\d*$/);
  // Refused sign-ins belong to no program: no count of 0, but where to look.
  await expect(page.getByText(/· \d+ refused sign-in/)).toHaveCount(0);
  await expect(
    page.getByText(/System administrators review them under Unassigned/),
  ).toBeVisible();
  // Free text never reaches the summary: only counts and notable actions.
  await expect(page.getByText("cabin door seal worn")).toHaveCount(0);

  await page.getByRole("button", { name: "Last 30 days" }).click();
  await expect(row).toBeVisible();

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^change-summary-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain('"Actor","Flights and discrepancies"');
  expect(csv).toContain('"Alex Morgan"');
  expect(csv).not.toContain("Refused sign-ins");
});
