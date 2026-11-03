import { test, expect } from "@playwright/test";

test("selects requirement tracking and excludes hidden limits when saving", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/aircraft");
  await page
    .getByRole("list", { name: "Aircraft", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "N206MA" })
    .getByRole("button", { name: "Add component", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Component type", { exact: true })
    .selectOption("Engine");
  await dialog
    .getByLabel("Component Name", { exact: true })
    .fill("Tracking test");
  await dialog.getByLabel("Part number", { exact: true }).fill("TRACK-OPTIONS");
  await dialog.getByLabel("Serial number", { exact: true }).fill("TRACK-001");
  await dialog.getByLabel(/This component is already installed/).check();
  await dialog
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.goto("/components");
  const component = page.getByRole("row").filter({ hasText: "TRACK-OPTIONS" });
  await component.getByRole("button", { name: "Details", exact: true }).click();
  // The details action that opens the service-requirement form is now
  // labelled "Add service requirement".
  await dialog
    .getByRole("button", { name: "Add service requirement", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Component service requirement",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Tracking options requirement");
  await dialog.getByLabel("Hour limit / interval", { exact: true }).fill("100");
  await dialog
    .getByLabel("Cycle limit / interval", { exact: true })
    .fill("200");
  await dialog.getByLabel("Calendar interval", { exact: true }).fill("12");
  await dialog.getByLabel("Calendar", { exact: true }).uncheck();
  await dialog.getByLabel("Cycles", { exact: true }).uncheck();
  await expect(
    dialog.getByLabel("Calendar interval", { exact: true }),
  ).not.toBeVisible();
  await expect(
    dialog.getByLabel("Cycle limit / interval", { exact: true }),
  ).not.toBeVisible();
  await dialog.getByLabel("Hours", { exact: true }).uncheck();
  await expect(
    dialog.getByLabel("Time basis", { exact: true }),
  ).not.toBeVisible();
  await dialog.getByLabel("Hours", { exact: true }).check();
  await expect(
    dialog.getByLabel("Hour limit / interval", { exact: true }),
  ).toHaveValue("100");
  await dialog
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await component.getByRole("button", { name: "Details", exact: true }).click();
  const requirement = dialog
    .getByRole("row")
    .filter({ hasText: "Tracking options requirement" });
  await expect(requirement).toContainText("100.0 TSN");
  await requirement
    .getByRole("button", { name: "Edit requirement", exact: true })
    .click();
  await expect(dialog.getByLabel("Hours", { exact: true })).toBeChecked();
  await expect(
    dialog.getByLabel("Calendar", { exact: true }),
  ).not.toBeChecked();
  await expect(dialog.getByLabel("Cycles", { exact: true })).not.toBeChecked();
  await expect(
    dialog.getByLabel("Calendar interval", { exact: true }),
  ).not.toBeVisible();
  await dialog.getByLabel("Cycles", { exact: true }).check();
  await expect(
    dialog.getByLabel("Cycle limit / interval", { exact: true }),
  ).toHaveValue("");
  await dialog.getByLabel("Cycles", { exact: true }).uncheck();
  await dialog.getByLabel("Hours", { exact: true }).uncheck();
  await dialog.getByLabel("Landings", { exact: true }).check();
  await dialog
    .getByLabel("Landing limit / interval", { exact: true })
    .fill("500");
  await dialog
    .getByLabel("Last complied at (aircraft total landings)", { exact: true })
    .fill("1000");
  await dialog
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await component.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    dialog.getByRole("row").filter({ hasText: "Tracking options requirement" }),
  ).toContainText("1500 landings");
});
