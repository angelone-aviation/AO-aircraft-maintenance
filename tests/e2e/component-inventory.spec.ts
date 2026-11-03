import { test, expect } from "@playwright/test";
import { localDate } from "../../src/domain/model";
import path from "node:path";
import { openMovementOrder } from "../fixtures/workOrderTasks";

test("routes tracked inventory components and returns the same item to its location after removal", async ({
  page,
}) => {
  const finishMovement = async () => {
    const order = await openMovementOrder(page, "TRACK-PUMP");
    await order.getByLabel("Task 1 status").selectOption("completed");
    await order
      .getByLabel("Task 1 work notes")
      .fill("Verified component identity and performed movement.");
    await order.getByLabel("Work order status").selectOption("completed");
    await order.getByLabel("Completion date").fill(localDate());
    await order
      .getByLabel("Release outcome")
      .fill("Component movement recorded and reviewed");
    page.once("dialog", (d) => d.accept());
    await order
      .getByRole("button", { name: "Save work order", exact: true })
      .click();
    await expect(order).not.toBeVisible();
  };
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New location", exact: true }).click();
  await page
    .getByLabel("Location name", { exact: true })
    .fill("Component store");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "New stock item", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Trackable Aircraft Component" });
  await dialog
    .getByLabel("Component type", { exact: true })
    .selectOption("Appliance");
  await dialog.getByLabel("Part number", { exact: true }).fill("TRACK-PUMP");
  await dialog.getByLabel("Serial number", { exact: true }).fill("SERIAL-42");
  await dialog
    .getByLabel("Inventory location", { exact: true })
    .selectOption({ label: "Component store" });
  await dialog.getByLabel("Parts location", { exact: true }).fill("Bin 4");
  await dialog
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("250");
  await dialog
    .getByText("Incoming component tag / 8130 details", { exact: true })
    .click();
  await dialog
    .getByLabel("Last operator / aircraft", { exact: true })
    .fill("N-INCOMING");
  await dialog
    .getByLabel("Inventory attachment file")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await dialog
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const inventoryRow = page.getByRole("row").filter({ hasText: "TRACK-PUMP" });
  await expect(inventoryRow).toContainText("Trackable Aircraft Component");
  await expect(inventoryRow).toContainText("SERIAL-42");
  await expect(inventoryRow).toContainText("Component store · Bin 4");
  await inventoryRow
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Open PDF", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Last operator / aircraft", { exact: true }),
  ).toHaveValue("N-INCOMING");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await inventoryRow
    .getByRole("button", { name: "Install / service", exact: true })
    .click();
  const sourceAircraft = await dialog
    .getByLabel("Movement aircraft")
    .locator("option:checked")
    .innerText();
  await dialog
    .getByLabel("Movement description / reason")
    .fill("Install tracked pump from inventory");
  await dialog
    .getByRole("button", { name: "Add movement to work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(inventoryRow).toHaveCount(1);
  await finishMovement();
  await page.goto("/inventory");
  await expect(inventoryRow).toHaveCount(0);
  await page.goto("/components");
  const componentRow = page.getByRole("row").filter({ hasText: "TRACK-PUMP" });
  await expect(componentRow).toContainText("Installed");

  await expect(componentRow).toContainText("250.0 h");
  await componentRow
    .getByRole("button", { name: "Add Service/Inspections", exact: true })
    .click();
  await dialog
    .getByLabel("Removal inventory location", { exact: true })
    .selectOption({ label: "Component store" });
  await dialog.getByLabel("Shelf / bin", { exact: true }).fill("Bin 8");
  await dialog
    .getByLabel("Movement description / reason")
    .fill("Remove tracked pump to inventory");
  await dialog
    .getByRole("button", { name: "Add movement to work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(componentRow).toContainText("Installed");
  await finishMovement();
  await page.goto("/inventory");
  await page.reload();
  await expect(inventoryRow).toHaveCount(1);
  await expect(inventoryRow).toContainText("Component store · Bin 8");
  await inventoryRow
    .getByRole("button", { name: "Print Tag", exact: true })
    .click();
  const tag = page.getByRole("dialog", { name: "Print Tag", exact: true });
  await expect(
    tag.getByLabel("Last operator / aircraft", { exact: true }),
  ).toHaveValue(sourceAircraft);
  await expect(tag.getByLabel("Removal date", { exact: true })).toHaveValue(
    localDate(),
  );
  await expect(tag.getByLabel("Position", { exact: true })).not.toHaveValue("");
  await expect(tag.getByLabel("Reason", { exact: true })).toHaveValue(
    /Remove tracked pump to inventory/,
  );
  await tag.getByRole("button", { name: "Close dialog", exact: true }).click();

  await inventoryRow
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Open PDF", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.goto("/components");
  await expect(componentRow).toHaveCount(1);
  await expect(componentRow).toContainText("250.0 h");
  await componentRow
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(
    dialog.getByRole("row").filter({ hasText: "REMOVE" }),
  ).toContainText("Bin 8");
  await expect(
    dialog.getByRole("row").filter({ hasText: "INSTALL" }),
  ).toHaveCount(1);
});
