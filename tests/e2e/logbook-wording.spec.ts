import { test, expect } from "@playwright/test";
import { localDate } from "../../src/domain/model";
import { expandTask } from "../fixtures/workOrderTasks";

test("saves custom wording and generates selected work with the reference fallback", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Work order number").fill("WO-WORDING");
  await dialog.getByLabel("Additional requested work").fill("Cabin fittings");
  await dialog
    .getByRole("button", { name: "Add requested work", exact: true })
    .click();
  const sample = dialog.getByLabel("Sample log book entry text");
  await expect(sample).not.toHaveValue(/Task #1 Cabin fittings/);
  await expandTask(dialog, 1);
  await dialog.getByLabel("Include in log book entry").check();
  await expect(sample).toHaveValue(
    /Task #1 Cabin fittings: performed IAW Standard Practice found in AC43.13/,
  );
  await dialog
    .getByLabel("Task 1 maintenance manual reference")
    .fill("AMM 25-10");
  await expect(sample).toHaveValue(/IAW AMM 25-10/);
  await dialog.getByLabel("Task 1 maintenance manual reference").fill("");
  await dialog.getByLabel("Include unfinished work in sample").uncheck();
  await expect(sample).not.toHaveValue(/Task #1 Cabin fittings/);
  await dialog.getByLabel("Include unfinished work in sample").check();
  await dialog.getByRole("button", { name: "Manage log book phrases" }).click();
  await dialog
    .getByLabel("My log book phrases (one per line)")
    .fill("Performed\nInspected\nOperationally checked");
  await dialog
    .getByRole("button", { name: "Save phrases", exact: true })
    .click();
  await dialog
    .getByLabel("Log book wording", { exact: true })
    .selectOption("Operationally checked");
  await expect(sample).toHaveValue(
    /Task #1 Cabin fittings: Operationally checked IAW Standard Practice found in AC43.13/,
  );
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: "WO-WORDING" });
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expandTask(dialog, 1);
  await expect(dialog.getByLabel("Include in log book entry")).toBeChecked();
  await expect(
    dialog.getByLabel("Log book wording", { exact: true }),
  ).toHaveValue("Operationally checked");
  await dialog.getByLabel("Task 1 status").selectOption("completed");
  await dialog.getByLabel("Work order status").selectOption("completed");
  await dialog.getByLabel("Completion date").fill(localDate());
  await dialog
    .getByLabel("Release statement", { exact: true })
    .selectOption({ label: "Maintenance — return to service" });
  await expect(
    dialog.getByLabel("Release outcome", { exact: true }),
  ).toHaveValue(/maintenance listed above/);
  await expect(sample).toHaveValue(/maintenance listed above/);
  await dialog
    .getByRole("button", { name: "Manage release statements", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add release statement", exact: true })
    .click();
  await dialog.getByLabel("Statement 6 name").fill("My release");
  await dialog.getByLabel("Statement 6 text").fill("Completed and reviewed.");
  await dialog
    .getByRole("button", { name: "Save release statements", exact: true })
    .click();
  await dialog
    .getByLabel("Release statement", { exact: true })
    .selectOption({ label: "My release" });
  await expect(sample).toHaveValue(/Completed and reviewed\./);
  await dialog
    .getByLabel("Release outcome", { exact: true })
    .fill("Completed and reviewed for this order.");
  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Include closed work orders").check();
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await dialog.getByRole("button", { name: "Generate logbook entry" }).click();
  await expect(page.getByLabel("Logbook entry text")).toHaveValue(
    /Completed and reviewed for this order\./,
  );
  await expect(page.getByLabel("Logbook entry text")).toHaveValue(
    /Task #1 Cabin fittings: Operationally checked IAW Standard Practice found in AC43.13/,
  );
});
