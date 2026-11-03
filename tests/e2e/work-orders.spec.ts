import { test, expect } from "@playwright/test";
import { localDate } from "../../src/domain/model";
import path from "node:path";
import { expandTask } from "../fixtures/workOrderTasks";
test("opens an order, adds an inspection, tracks tasks, attaches a record and closes with review", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await expect(
    page.getByRole("heading", { name: "Work orders", exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("row").filter({ hasText: "WO-BROWSER-1" }),
  ).toContainText("0 / 1");
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page
    .getByRole("button", { name: "Add to work order", exact: true })
    .first()
    .click();
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  // The picker stays open to report job-card preparation.
  await expect(dialog.getByRole("status")).toContainText("Item added");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("link", { name: "Work orders", exact: true }).click();
  let row = page.getByRole("row").filter({ hasText: "WO-BROWSER-1" });
  await expect(row).toContainText("0 / 2");
  await page.reload();
  row = page.getByRole("row").filter({ hasText: "WO-BROWSER-1" });
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expandTask(dialog, 1);
  await dialog.getByLabel("Task 1 status").selectOption("parts-delay");
  await dialog
    .getByLabel("Task 1 parts delay")
    .fill("Awaiting replacement fitting");
  await dialog
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(row.getByRole("cell").nth(5)).toHaveText("1"); // parts delays
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await dialog
    .getByLabel("Maintenance record file")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await dialog
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "icao-flight-plan.pdf" }),
  ).toBeVisible();
  await expandTask(dialog, 1);
  await expandTask(dialog, 2);
  await dialog.getByLabel("Task 1 status").selectOption("completed");
  await dialog.getByLabel("Task 2 status").selectOption("completed");
  await dialog.getByLabel("Work order status").selectOption("completed");
  await dialog.getByLabel("Completion date").fill(localDate());
  await dialog.getByLabel("Release outcome").fill("Maintenance completed");
  page.once("dialog", (dialog) => dialog.accept());
  await dialog
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByLabel("Include closed work orders").check();
  await expect(row).toContainText("completed");
  await expect(row).toContainText("2 / 2");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Save work order", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "icao-flight-plan.pdf" }),
  ).toBeVisible();
});

test("selects component times and adds component service and discrepancy records from their screens", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await expect(
    page.getByRole("heading", { name: "Work orders", exact: true }),
  ).toBeVisible();
  const { workOrderComponent } = await import("../fixtures/workOrders");
  await page.evaluate(async (component) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readwrite");
        const cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.management = [
            component,
            {
              kind: "componentRequirement",
              uuid: "engine-service",
              version: 1,
              aircraftUuid: component.aircraftUuid,
              componentUuid: component.uuid,
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
              aircraftUuid: component.aircraftUuid,
              description: "Work order oil leak test",
              status: "open",
              authorId: s.user.id,
              createdAt: Date.now(),
            },
          ];
          entry.update(s);
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, workOrderComponent());
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
  await picker.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(picker.getByRole("status")).toContainText("Item added");
  await picker
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page
    .getByRole("button", { name: "Add to work order", exact: true })
    .click();
  await picker.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(picker.getByRole("status")).toContainText("Item added");
  await picker
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await page.getByRole("link", { name: "Work orders", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "WO-COMPONENT" });
  await expect(row).toContainText("0 / 2");
  // Outstanding discrepancies (the scope column was removed).
  await expect(row.getByRole("cell").nth(4)).toHaveText("1");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    dialog.getByText("Engine (SN) / Engine service test", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Work order oil leak test", { exact: true }),
  ).toBeVisible();
});
