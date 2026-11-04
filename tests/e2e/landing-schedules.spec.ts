/**
 * Responsibility: Pins landing-based schedules: a 500-landing template saved
 *   with only the tracking fields selected, and an inspection created from it
 *   that keeps them.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";

test("creates and persists a 500-landing template and inspection with selected tracking fields", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspection-templates");
  await page.getByRole("button", { name: "New template", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Inspection template",
    exact: true,
  });
  await editor
    .getByLabel("Template name", { exact: true })
    .fill("Phase 34 landing test");
  await editor.getByLabel("Manufacturer", { exact: true }).fill("Cessna");
  await editor
    .getByLabel("Aircraft type / component model", { exact: true })
    .fill("206 Stationair");
  await expect(
    editor.getByLabel("Hour interval / limit", { exact: true }),
  ).not.toBeVisible();
  await editor.getByLabel("Hours", { exact: true }).check();
  await editor.getByLabel("Hour interval / limit", { exact: true }).fill("100");
  await editor.getByLabel("Hours", { exact: true }).uncheck();
  await editor.getByLabel("Landings", { exact: true }).check();
  await editor
    .getByLabel("Landing interval / limit", { exact: true })
    .fill("500");
  await editor
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  const row = page
    .getByRole("row")
    .filter({ hasText: "Phase 34 landing test" });
  await expect(row).toContainText("500 landings");
  // Hours was unchecked before saving, so its 100-hour interval is not kept.
  await expect(row).not.toContainText("100 hours");
  await row
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  const activate = page.getByRole("dialog", {
    name: "Create inspection from template",
    exact: true,
  });
  await activate
    .getByLabel("Target aircraft", { exact: true })
    .selectOption("demo-206");
  await activate
    .getByLabel("Last complied at (aircraft total landings)", { exact: true })
    .fill("1000");
  // Due at the landings last complied plus the 500-landing interval.
  await expect(activate.getByRole("status")).toContainText(
    "1500 aircraft landings",
  );
  await activate.getByRole("checkbox", { name: /I reviewed/ }).check();
  await activate
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(activate).not.toBeVisible();
  await page.goto("/inspections");
  const inspection = page
    .getByRole("row")
    .filter({ hasText: "Phase 34 landing test" });
  await expect(inspection).toContainText("1500 landings");
  await inspection
    .getByRole("button", { name: "Details", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Landings", { exact: true })).toBeChecked();
  await expect(
    dialog.getByLabel("Repeat every (landings)", { exact: true }),
  ).toHaveValue("500");
  await expect(dialog.getByLabel("Hours", { exact: true })).not.toBeChecked();
});
