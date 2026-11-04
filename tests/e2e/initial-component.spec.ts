/**
 * Responsibility: Pins adding an already installed component from its
 *   aircraft without a work order, then a trackable part under it with a life
 *   limit.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";

test("adds an already installed component from its aircraft without a work order", async ({
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
  await row.getByRole("button", { name: "Add component", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("N206MA");
  await expect(dialog.getByLabel("Aircraft", { exact: true })).toBeDisabled();
  await dialog
    .getByLabel("Component type", { exact: true })
    .selectOption("Engine");
  await dialog
    .getByLabel("Component Name", { exact: true })
    .fill("Training engine");
  await dialog.getByLabel("Part number", { exact: true }).fill("SETUP-PN");
  await dialog.getByLabel("Serial number", { exact: true }).fill("SETUP-SN");
  await dialog.getByLabel(/This component is already installed/).check();
  await dialog
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.goto("/components");
  await expect(page.getByText(/SETUP-PN/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/SETUP-PN/)).toBeVisible();
  const engine = page.getByRole("row").filter({ hasText: "SETUP-PN" });
  await expect(engine).toContainText("Training engine");
  // Locate the group by its summary: role-based row locators skip hidden
  // rows, so a group found through its row cannot be reopened once collapsed.
  const aircraftGroup = page.locator("details.component-group").filter({
    has: page.locator("summary", { hasText: "N206MA" }),
  });
  await expect(
    aircraftGroup.getByRole("row").filter({ hasText: "SETUP-PN" }),
  ).toBeVisible();
  await aircraftGroup.locator("summary").click();
  await expect(engine).not.toBeVisible();
  await aircraftGroup.locator("summary").click();
  await expect(
    engine.getByRole("button", {
      name: "Add Service/Inspections",
      exact: true,
    }),
  ).toBeVisible();

  await engine.getByRole("button", { name: "Details", exact: true }).click();
  await page
    .getByRole("button", { name: "Add trackable parts", exact: true })
    .click();
  const part = page.getByRole("dialog");
  await part
    .getByLabel("Component type", { exact: true })
    .selectOption("Engine");
  await part
    .getByLabel("Component Name", { exact: true })
    .fill("Compressor disk");
  await part.getByLabel("Part number", { exact: true }).fill("DISK-PN");
  await part.getByLabel("Serial number", { exact: true }).fill("DISK-SN");
  await part.getByLabel(/This component is already installed/).check();
  await part
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Calculate and save", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByLabel("Description", { exact: true })
    .fill("Disk life limit");
  await page.getByLabel("Hour limit / interval", { exact: true }).fill("3000");
  await page
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  const disk = page.getByRole("row").filter({ hasText: "DISK-PN" });
  await expect(disk).toContainText("Compressor disk");
  await expect(disk).toContainText("Part of Training engine");
  await disk.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Disk life limit");
});
