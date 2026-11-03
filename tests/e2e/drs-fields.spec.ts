import { test, expect } from "@playwright/test";

test("searches DRS suggestions, saves custom profile values and uses the FAA model override", async ({
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
  const make = dialog.getByLabel("Make", { exact: true });
  await make.fill("Cessna");
  await expect(
    dialog.getByRole("option").filter({ hasText: "Cessna" }).first(),
  ).toBeVisible();
  await make.fill("Custom Air Works");
  await dialog.getByRole("option", { name: /Use “Custom Air Works”/ }).click();
  await dialog.getByLabel("Model", { exact: true }).fill("C441 Custom");
  await dialog.getByLabel("FAA search model (optional)").fill("441");
  await dialog.getByRole("option", { name: /^441\s*DRS$/ }).click();
  await dialog
    .getByRole("button", { name: "Save aircraft", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(row).toContainText("Custom Air Works");
  await expect(row).toContainText("C441 Custom");
  await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
  await expect(dialog.getByLabel("FAA search model (optional)")).toHaveValue(
    "441",
  );
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.goto("/airworthiness");
  await page.getByLabel("Aircraft", { exact: true }).selectOption("demo-206");
  await page.getByRole("button", { name: "Search FAA ADs & Import" }).click();
  await expect(dialog.getByLabel("N206MA model", { exact: true })).toHaveValue(
    "441",
  );
  await expect(
    dialog.getByLabel("N206MA manufacturer", { exact: true }),
  ).toHaveValue("Custom Air Works");
  await dialog
    .getByLabel("N206MA model", { exact: true })
    .fill("Unlisted Model 123");
  await dialog
    .getByRole("option", { name: /Use “Unlisted Model 123”/ })
    .click();
  await expect(dialog.getByLabel("N206MA model", { exact: true })).toHaveValue(
    "Unlisted Model 123",
  );
  await dialog.getByRole("button", { name: "Reset from profiles" }).click();
  await expect(dialog.getByLabel("N206MA model", { exact: true })).toHaveValue(
    "441",
  );
});
