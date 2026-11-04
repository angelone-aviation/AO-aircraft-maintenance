/**
 * Responsibility: Pins the work-order lifecycle: opening an order, adding
 *   work from the Inspections, Components and Discrepancies screens, task
 *   status and parts delays, a record attachment, closing with review, and
 *   the component times shown when the order opens.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, src/domain/model (localDate),
 *   tests/fixtures (workOrders, workOrderTasks).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { localDate } from "../../src/domain/model";
import type { Component } from "../../src/domain/components";
import { workOrderComponent } from "../fixtures/workOrders";
import { expandTask } from "../fixtures/workOrderTasks";

// Columns of the work-order list; the scope column was removed.
const OUTSTANDING_DISCREPANCIES_COLUMN = 4;
const PARTS_DELAYS_COLUMN = 5;

test("opens an order, adds an inspection, tracks tasks, attaches a record and closes with review", async ({
  page,
}) => {
  await openWorkOrders(page);
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Aircraft total time", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Work order number").fill("WO-BROWSER-1");
  await dialog.getByLabel("Assigned supervisor").fill("Test supervisor");
  await dialog
    .getByLabel("Additional requested work")
    .fill("Inspect cabin fittings");
  await dialog
    .getByRole("button", { name: "Add requested work", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const row = orderRow(page, "WO-BROWSER-1");
  await expect(row).toContainText("0 / 1");
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page
    .getByRole("button", { name: "Add to work order", exact: true })
    .first()
    .click();
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  // The picker stays open to report job-card preparation.
  await expect(dialog.getByRole("status")).toContainText("Item added");
  await closeDialog(dialog);
  await expect(dialog).not.toBeVisible();
  await page.getByRole("link", { name: "Work orders", exact: true }).click();
  await expect(row).toContainText("0 / 2");
  await page.reload();
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expandTask(dialog, 1);
  await dialog.getByLabel("Task 1 status").selectOption("parts-delay");
  await dialog
    .getByLabel("Task 1 parts delay")
    .fill("Awaiting replacement fitting");
  await saveOrderButton(dialog).click();
  await expect(row.getByRole("cell").nth(PARTS_DELAYS_COLUMN)).toHaveText("1");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await attachMaintenanceRecord(dialog);
  await closeOrder(page, dialog);
  await expect(row).toHaveCount(0);
  await page.getByLabel("Include closed work orders").check();
  await expect(row).toContainText("completed");
  await expect(row).toContainText("2 / 2");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expect(saveOrderButton(dialog)).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "icao-flight-plan.pdf" }),
  ).toBeVisible();
});

test("selects component times and adds component service and discrepancy records from their screens", async ({
  page,
}) => {
  await openWorkOrders(page);
  await storeEngineRecords(page, workOrderComponent());
  await page.reload();
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Work order number").fill("WO-COMPONENT");
  await dialog.getByRole("checkbox", { name: /Engine/ }).check();
  await expect(
    dialog.getByRole("cell", { name: "110.0 h", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("cell", { name: "30.0 h", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("link", { name: "Components", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Engine" })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add to work order", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Add to work order",
    exact: true,
  });
  await addItemFromPicker(picker);
  await closeDialog(dialog);
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page
    .getByRole("button", { name: "Add to work order", exact: true })
    .click();
  await addItemFromPicker(picker);
  await page.getByRole("link", { name: "Work orders", exact: true }).click();
  const row = orderRow(page, "WO-COMPONENT");
  await expect(row).toContainText("0 / 2");
  await expect(
    row.getByRole("cell").nth(OUTSTANDING_DISCREPANCIES_COLUMN),
  ).toHaveText("1");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    dialog.getByText("Engine (SN) / Engine service test", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Work order oil leak test", { exact: true }),
  ).toBeVisible();
});

async function openWorkOrders(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await expect(
    page.getByRole("heading", { name: "Work orders", exact: true }),
  ).toBeVisible();
}

/**
 * Replaces the management records with the fixture engine and a monthly
 * service requirement on it, and the discrepancies with one open oil leak, in
 * every stored snapshot.
 */
async function storeEngineRecords(page: Page, component: Component) {
  await page.evaluate(async (engine) => {
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
        engine,
        {
          kind: "componentRequirement",
          uuid: "engine-service",
          version: 1,
          aircraftUuid: engine.aircraftUuid,
          componentUuid: engine.uuid,
          description: "Engine service test",
          requirementType: "Inspection Requirement",
          notes: "",
          calendarIntervalUnit: "MONTHS",
          timeBasis: "TSN",
          timeLimitMode: "ABSOLUTE",
          cycleLimitMode: "ABSOLUTE",
          warningCalendarMonths: 1,
          warningSeconds: 0,
          warningCycles: 0,
        },
      ];
      s.discrepancies = [
        {
          uuid: "leak-test",
          aircraftUuid: engine.aircraftUuid,
          description: "Work order oil leak test",
          status: "open",
          authorId: s.user.id,
          createdAt: Date.now(),
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

async function attachMaintenanceRecord(dialog: Locator) {
  await dialog
    .getByLabel("Maintenance record file")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await dialog
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "icao-flight-plan.pdf" }),
  ).toBeVisible();
}

/** Completes both tasks and the order, accepting the permanence warning. */
async function closeOrder(page: Page, dialog: Locator) {
  await expandTask(dialog, 1);
  await expandTask(dialog, 2);
  await dialog.getByLabel("Task 1 status").selectOption("completed");
  await dialog.getByLabel("Task 2 status").selectOption("completed");
  await dialog.getByLabel("Work order status").selectOption("completed");
  await dialog.getByLabel("Completion date").fill(localDate());
  await dialog.getByLabel("Release outcome").fill("Maintenance completed");
  page.once("dialog", (confirm) => confirm.accept());
  await saveOrderButton(dialog).click();
  await expect(dialog).not.toBeVisible();
}

async function addItemFromPicker(picker: Locator) {
  await picker.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(picker.getByRole("status")).toContainText("Item added");
  await closeDialog(picker);
  await expect(picker).not.toBeVisible();
}

function orderRow(page: Page, number: string): Locator {
  return page.getByRole("row").filter({ hasText: number });
}

function saveOrderButton(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: "Save work order", exact: true });
}

async function closeDialog(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
}
