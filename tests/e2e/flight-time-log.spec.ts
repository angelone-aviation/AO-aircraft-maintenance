/**
 * Responsibility: Pins the Flight time log meter: enabling it without changing
 *   total time, logging a flight on it alone, and turning it off again.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures/localDateTime.
 */
import { test, expect } from "@playwright/test";
import { localDateTime } from "../fixtures/localDateTime";

const MINUTE_MS = 60 * 1000;

test("configures Flight time log and records a flight without Hobbs or tach readings", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/aircraft");
  const row = page
    .getByRole("list", { name: "Aircraft", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "N206MA" });
  await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const meter = dialog.getByLabel("Default maintenance time source");
  await expect(meter.locator('option[value="flightTimeLog"]')).toHaveCount(0);
  await expect(
    dialog.getByLabel("Current Flight time log (hours)"),
  ).toHaveCount(0);
  await dialog.getByLabel("Flight time log", { exact: true }).check();
  await dialog.getByLabel("Current Flight time log (hours)").fill("100");
  const total = await dialog
    .getByRole("status")
    .locator("strong")
    .textContent();
  await meter.selectOption("flightTimeLog");
  await expect(dialog.getByRole("status").locator("strong")).toHaveText(total!);
  await dialog
    .getByRole("button", { name: "Save aircraft", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toContainText("Flight time log: 100.0 h");
  await page.reload();
  await page.goto("/flights");
  await page
    .getByRole("button", { name: "Log a completed flight", exact: true })
    .click();
  const aircraft = dialog.getByLabel("Aircraft", { exact: true });
  const option = aircraft.locator("option").filter({ hasText: "N206MA" });
  await aircraft.selectOption((await option.getAttribute("value"))!);
  await expect(
    dialog.getByLabel("Starting Flight time log (hours)"),
  ).toHaveValue("100.0");
  // Enabling the log is a counter change timed now, and a flight at or before
  // it would be held for chronology review.
  await dialog
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() + MINUTE_MS));
  await dialog
    .getByLabel("Ending Flight time log", { exact: false })
    .fill("101.2");
  await dialog.getByLabel("Origin", { exact: true }).fill("FLIGHT-TIME-TEST");
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "FLIGHT-TIME-TEST" }),
  ).toContainText("101.2");
  await page.goto("/aircraft");
  await expect(row).toContainText("Flight time log: 101.2 h");
  await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
  await dialog.getByLabel("Flight time log", { exact: true }).uncheck();
  await expect(meter).toHaveValue("hobbs");
  await expect(
    dialog.getByLabel("Current Flight time log (hours)"),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Save aircraft", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(row).not.toContainText("Flight time log:");
});
