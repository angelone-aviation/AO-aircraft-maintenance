/**
 * Responsibility: Pins Flight Programs and aircraft setup: a new program with
 *   its default groups, total time from the chosen meter and its adjustment,
 *   switching programs, and edits refused offline.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";
test("program directory and aircraft total-time setup persist through editing and reload", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await page
    .getByRole("link", { name: "Flight Programs", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add Flight Program", exact: true })
    .click();
  await page
    .getByLabel("Flight Program name", { exact: true })
    .fill("Medical flight program");
  await page
    .getByLabel("Program address — Street address", { exact: true })
    .fill("Hangar 4, Regional Airport");
  await page
    .getByLabel("Program address — Email", { exact: true })
    .fill("ops@example.test");
  await page
    .getByLabel("Program address — Contact name", { exact: true })
    .fill("Casey Pilot");
  await page
    .getByLabel("Website", { exact: true })
    .fill("example.test/mission");
  await page.getByLabel("Website", { exact: true }).blur();
  await expect(page.getByLabel("Website", { exact: true })).toHaveValue(
    "https://example.test/mission",
  );
  await page
    .getByRole("button", { name: "Save Flight Program", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByLabel("Active Flight Program", { exact: true })
    .selectOption({ label: "Medical flight program" });
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await page
    .getByRole("button", { name: "Permission groups", exact: true })
    .click();
  // A new Flight Program starts with the four default permission groups.
  for (const name of [
    "Observers",
    "Pilots",
    "Maintenance technicians",
    "Program managers",
  ]) {
    await expect(
      page
        .locator(".list-row")
        .filter({ has: page.getByText(name, { exact: true }) }),
    ).toHaveCount(1);
  }
  await page.getByRole("link", { name: "Aircraft", exact: true }).click();
  await page.getByRole("button", { name: "Add aircraft", exact: true }).click();
  await page.getByLabel("Registration", { exact: true }).fill("N500TEST");
  await page.getByLabel("Make", { exact: true }).fill("Cessna");
  await page.getByLabel("Model", { exact: true }).fill("206");
  await page.getByLabel("Serial number", { exact: true }).fill("SER-500");
  await expect(
    page.getByLabel("Flight Program name", { exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Current Hobbs (hours)", { exact: true }).fill("1200");
  await page.getByLabel("Current tach (hours)", { exact: true }).fill("1000");
  await page
    .getByLabel("Default maintenance time source", { exact: true })
    .selectOption("tach");
  await page
    .getByLabel("Total time adjustment (hours)", { exact: true })
    .fill("50");
  // Total time follows the tach: 1,000 plus the 50-hour adjustment.
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "1,050.0 hours",
  );
  // Cycles are only tracked for turbine aircraft.
  await expect(page.getByLabel("Current cycles", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Current landings", { exact: true }).fill("550");
  await page
    .getByLabel("Status (manual assessment)", { exact: true })
    .selectOption("maintenance");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add aircraft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const row = page
    .getByRole("list", { name: "Aircraft", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "N500TEST" });
  await expect(row).toContainText("1,050.0 h");
  await expect(row).toContainText("Medical flight program");
  await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
  await page
    .getByLabel("Default maintenance time source", { exact: true })
    .selectOption("hobbs");
  // On the Hobbs (1,200) the adjustment becomes -150, keeping the total.
  await expect(
    page.getByLabel("Total time adjustment (hours)", { exact: true }),
  ).toHaveValue("-150");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "1,050.0 hours",
  );
  await page
    .getByRole("button", { name: "Save aircraft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Flight Programs", exact: true })
    .click();
  await page
    .getByRole("list", { name: "Flight Programs", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "Medical flight program" })
    .getByRole("button", { name: "Edit Flight Program details" })
    .click();
  await page
    .getByLabel("Flight Program name", { exact: true })
    .fill("Regional medical program");
  await page
    .getByRole("button", { name: "Save Flight Program", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Aircraft", exact: true }).click();
  await page.reload();
  await expect(row).toContainText("Regional medical program");
  await expect(row).toContainText("1,050.0 h");
  await expect(row).toContainText("Adjustment -150.0 h");
  await page
    .getByLabel("Active Flight Program", { exact: true })
    .selectOption({ label: "Mission operations" });
  await expect(row).not.toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Aircraft", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "N206MA" }),
  ).toBeVisible();
  await page
    .getByLabel("Active Flight Program", { exact: true })
    .selectOption({ label: "Regional medical program" });
  await expect(row).toBeVisible();
  // Switching programs and editing aircraft need a connection.
  await context.setOffline(true);
  await expect(
    page.getByLabel("Active Flight Program", { exact: true }),
  ).toBeDisabled();
  await expect(
    row.getByRole("button", { name: "Edit aircraft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add aircraft", exact: true }),
  ).toBeDisabled();
});
