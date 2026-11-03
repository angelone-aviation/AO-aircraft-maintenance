import { test, expect } from "@playwright/test";

test("adds scheduled AD actions from the register and details without duplicates", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  let dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Work order number").fill("WO-AD-ACTIONS");
  await dialog.getByLabel("Assigned supervisor").fill("Test supervisor");
  await dialog
    .getByLabel("Additional requested work")
    .fill("Initial maintenance review");
  await dialog
    .getByRole("button", { name: "Add requested work", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();

  await page.goto("/airworthiness");
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("AD number", { exact: true }).fill("2026-10-28");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Scheduled attachment inspections");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Applicable");
  await dialog.getByLabel("Applicability and source changes reviewed").check();
  for (const description of [
    "Inspect forward fittings",
    "Inspect aft fittings",
  ]) {
    await dialog.getByRole("button", { name: "Add required action" }).click();
    const action = dialog.locator("fieldset").last();
    await action
      .getByLabel("Required action", { exact: true })
      .fill(description);
    await action.getByLabel("Action recurrence").selectOption("Recurring");
    await action
      .getByRole("checkbox", { name: "Calendar", exact: true })
      .check();
    await action.getByLabel("Next due date").fill("2099-12-31");
    await action.getByLabel("Repeat every days").fill("365");
  }
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator(".ad-register-group > summary").first().click();
  const row = page.getByRole("row").filter({ hasText: "2026-10-28" });
  await expect(row).toContainText("Scheduled");
  await row
    .getByRole("button", { name: "Add to work order", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
  await expect(dialog.getByLabel("Required action")).toHaveCount(1);
  await dialog
    .getByLabel("Required action")
    .selectOption({ label: "AD 2026-10-28: Inspect forward fittings" });
  await dialog
    .getByLabel("Open work order")
    .selectOption({ label: "WO-AD-ACTIONS · N206MA" });
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Item added");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();

  await row.getByRole("button", { name: "Details for AD 2026-10-28" }).click();
  const details = page.getByRole("dialog").last();
  const firstAction = details
    .locator(".list-row")
    .filter({ hasText: "Inspect forward fittings" });
  await firstAction
    .getByRole("button", { name: "Add to work order", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
  await expect(
    dialog
      .getByLabel("Open work order")
      .locator("option")
      .filter({ hasText: "WO-AD-ACTIONS" }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const secondAction = details
    .locator(".list-row")
    .filter({ hasText: "Inspect aft fittings" });
  await secondAction
    .getByRole("button", { name: "Add to work order", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
  await dialog
    .getByLabel("Open work order")
    .selectOption({ label: "WO-AD-ACTIONS · N206MA" });
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Item added");
  await page.goto("/work-orders");
  const order = page.getByRole("row").filter({ hasText: "WO-AD-ACTIONS" });
  await expect(order).toContainText("0 / 3");
  await order.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("dialog").last()).toContainText(
    "AD 2026-10-28: Inspect forward fittings",
  );
  await expect(page.getByRole("dialog").last()).toContainText(
    "AD 2026-10-28: Inspect aft fittings",
  );
});
