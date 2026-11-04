/**
 * Responsibility: Pins component movements requested in a work order: only
 *   this aircraft's components and this program's stock are offered, one
 *   action per component, and closing the order installs and removes them.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain (model, components types),
 *   tests/fixtures (workOrders, workOrderTasks).
 */
import { test, expect, type Page } from "@playwright/test";
import { localDate } from "../../src/domain/model";
import type { Component } from "../../src/domain/components";
import { workOrderComponent } from "../fixtures/workOrders";
import { expandTask } from "../fixtures/workOrderTasks";

test("requests installation and removal within a work order, excluding other aircraft", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await expect(
    page.getByRole("heading", { name: "Work orders", exact: true }),
  ).toBeVisible();
  await storeMovementComponents(page, workOrderComponent());
  await page.reload();
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Work order number").fill("WO-COMPONENT-PICKER");
  await dialog
    .getByRole("button", { name: "Install/remove component", exact: true })
    .click();
  const select = dialog.getByLabel("Component to install or remove");
  await expect(select).toContainText("REMOVE-ME");
  await expect(select).toContainText("INSTALL-ME");
  await expect(select).not.toContainText("EXCLUDED-PART");
  await expect(select).not.toContainText("FOREIGN-STOCK");
  await select.selectOption("on-aircraft");
  await dialog.getByLabel("Removal shelf / bin").fill("Shelf C");
  await dialog
    .getByLabel("Component movement description / reason")
    .fill("Remove for inspection");
  await dialog
    .getByRole("button", { name: "Add component movement", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Install/remove component", exact: true })
    .click();
  // A work order holds one action per component.
  await expect(select).not.toContainText("REMOVE-ME");
  await select.selectOption("in-inventory");
  await dialog
    .getByLabel("Installation position", { exact: true })
    .selectOption("MAIN");
  await dialog
    .getByLabel("Component movement description / reason")
    .fill("Install replacement component");
  await dialog
    .getByRole("button", { name: "Add component movement", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("row")
    .filter({ hasText: "WO-COMPONENT-PICKER" })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expandTask(dialog, 1);
  await expandTask(dialog, 2);
  await expect(dialog.getByLabel("Task 1 status")).toHaveValue("requested");
  await expect(dialog.getByLabel("Task 2 status")).toHaveValue("requested");
  await dialog.getByLabel("Task 1 status").selectOption("completed");
  await dialog.getByLabel("Task 2 status").selectOption("completed");
  await dialog.getByLabel("Work order status").selectOption("completed");
  await dialog.getByLabel("Completion date").fill(localDate());
  await dialog
    .getByLabel("Release outcome")
    .fill("Component exchange reviewed");
  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  // Closing the order applies both movements.
  await page.goto("/components");
  await expect(
    page.getByRole("row").filter({ hasText: "REMOVE-ME" }),
  ).toContainText("In storage");
  await expect(
    page.getByRole("row").filter({ hasText: "INSTALL-ME" }),
  ).toContainText("Installed");
});

/**
 * Replaces the management records in every snapshot on the device with four
 * copies of `component`: installed on the first aircraft, in this program's
 * stock, on the second aircraft, and in another program's stock.
 */
async function storeMovementComponents(page: Page, component: Component) {
  await page.evaluate(async (c) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("snapshots", "readwrite");
    const cursor = tx.objectStore("snapshots").openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const s = entry.value;
      s.management = [
        {
          ...c,
          uuid: "on-aircraft",
          partNumber: "REMOVE-ME",
          installPosition: "MAIN",
          aircraftUuid: s.aircraft[0].uuid,
        },
        {
          ...c,
          uuid: "in-inventory",
          partNumber: "INSTALL-ME",
          installed: false,
          aircraftUuid: "",
          programUuid: s.aircraft[0].programUuid,
          partsLocation: "Shelf A",
        },
        {
          ...c,
          uuid: "other-aircraft",
          partNumber: "EXCLUDED-PART",
          aircraftUuid: s.aircraft[1].uuid,
        },
        {
          ...c,
          uuid: "foreign-stock",
          partNumber: "FOREIGN-STOCK",
          installed: false,
          aircraftUuid: "",
          programUuid: "another-program",
          partsLocation: "Shelf B",
        },
      ];
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, component);
}
