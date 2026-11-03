import { test, expect } from "@playwright/test";

test("calendar exemption persists and can be removed without changing its interval", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspections");
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  const months = await dialog.locator('[name="intervalMonths"]').inputValue();
  const date = await dialog.locator('[name="lastDate"]').inputValue();
  await dialog
    .getByRole("checkbox", { name: "Calendar exempt", exact: true })
    .check();
  await expect(
    dialog.getByLabel("Calendar exemption reason / reference"),
  ).toHaveAttribute("required", "");
  await dialog
    .getByLabel("Calendar exemption reason / reference")
    .fill("Phases 52–56; verified manual reference");
  await dialog
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: /Calendar exempt/ }).first(),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: /Calendar exempt/ }) })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(
    dialog.getByRole("checkbox", { name: "Calendar exempt", exact: true }),
  ).toBeChecked();
  await expect(dialog.locator('[name="intervalMonths"]')).toHaveValue(months);
  await expect(dialog.locator('[name="lastDate"]')).toHaveValue(date);
  await expect(dialog.getByText(/Last changed/)).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "Calendar exempt", exact: true })
    .uncheck();
  await dialog
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("cell", { name: /Calendar exempt/ })).toHaveCount(
    0,
  );
});
