/**
 * Responsibility: Pins the component close-out correction on a completed work
 *   order: the tracking preview, the confirmed correction kept beside the
 *   original close-out, its downloadable addendum and the corrected times.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:fs/promises, src/domain (model,
 *   components), tests/fixtures (workOrders, workOrderTasks).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { localDate } from "../../src/domain/model";
import type { Component } from "../../src/domain/components";
import { workOrderComponent } from "../fixtures/workOrders";
import { expandTask } from "../fixtures/workOrderTasks";

const ORDER_NUMBER = "WO-CORRECTION";
// The fixture engine as the order's component work names it.
const ENGINE = "Engine · SN";
const REPAIR = "Cylinder repaired, not overhauled";
const REASON = "Close-out recorded the wrong work";
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

test("corrects an overhaul to a repair with a preview, keeps the original close-out and offers the addendum", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await expect(
    page.getByRole("heading", { name: "Work orders", exact: true }),
  ).toBeVisible();
  await storeComponent(page, workOrderComponent());
  await page.reload();
  const today = localDate();
  const dialog = page.getByRole("dialog");
  await openOrderOnEngine(page, dialog);
  await closeAsOverhaul(page, dialog, today);
  await page.getByLabel("Include closed work orders").check();
  await openDetails(page);
  const panel = dialog.getByRole("region", {
    name: "Component closeout corrections",
    exact: true,
  });
  const preview = await previewRepair(panel);
  await expect(preview.getByText("Overhauled → Repaired")).toBeVisible();
  // The engine read 110 h TSN and 30 h TSO with no TSR before its overhaul.
  for (const reading of [
    "TSN 110.0 h 110.0 h 110.0 h 110.0 h",
    "TSO 0.0 h 30.0 h 0.0 h 30.0 h",
    "TSR Not recorded 0.0 h Not recorded 0.0 h",
    "Cycles 40 40 40 40",
  ])
    await expect(
      preview.getByRole("row", { name: reading, exact: true }),
    ).toBeVisible();
  await preview.getByRole("checkbox").check();
  await preview
    .getByRole("button", { name: "Confirm tracking correction", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await openDetails(page);
  await expect(
    dialog.getByRole("heading", { name: /: Overhauled$/ }),
  ).toBeVisible();
  await expect(panel.getByText(/^Logbook review required/)).toBeVisible();
  const addendum = await downloadAddendum(page, panel);
  // Characterizes current behaviour: no full stop is added after a work
  // description that lacks one.
  expect(addendum.replace(ISO_TIMESTAMP, "<recorded>")).toBe(
    `Correction to work order ${ORDER_NUMBER}, component Engine P/N PN; S/N SN, maintenance dated ${today}: Overhauled corrected to Repaired. ${REPAIR} Corrected completion TSN 110.0 h; TSO 30.0 h; TSR 0.0 h; cycles 40. Reason: ${REASON}. Recorded by Alex Morgan on <recorded>. Review alongside the original logbook entry.`,
  );
  await expect(
    panel.getByText(`Reason: ${REASON}`, { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(addendum, { exact: true })).toBeVisible();
  await page.goto("/components");
  await expect(
    page.getByRole("row").filter({ hasText: "S/N SN" }),
  ).toContainText("TSO 30.0 h · TSR 0.0 h");
});

/**
 * Replaces the management records in every stored snapshot with one
 * component, so the screen shows it after a reload.
 */
async function storeComponent(page: Page, component: Component) {
  await page.evaluate(async (record) => {
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
      entry.update({ ...entry.value, management: [record] });
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, component);
}

/** Opens an order with one requested task that includes the engine. */
async function openOrderOnEngine(page: Page, dialog: Locator) {
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await dialog.getByLabel("Work order number").fill(ORDER_NUMBER);
  await dialog.getByRole("checkbox", { name: /Engine/ }).check();
  await dialog
    .getByLabel("Additional requested work")
    .fill("Overhaul the engine");
  await dialog
    .getByRole("button", { name: "Add requested work", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

/** Completes the order as an engine overhaul, accepting the warning. */
async function closeAsOverhaul(page: Page, dialog: Locator, date: string) {
  await openDetails(page);
  await dialog
    .getByLabel(`${ENGINE} work performed`, { exact: true })
    .selectOption({ label: "Overhauled" });
  await dialog
    .getByLabel(`${ENGINE} work description`, { exact: true })
    .fill("Engine overhauled");
  await expandTask(dialog, 1);
  await dialog.getByLabel("Task 1 status").selectOption("completed");
  await dialog.getByLabel("Work order status").selectOption("completed");
  await dialog.getByLabel("Completion date").fill(date);
  await dialog.getByLabel("Release outcome").fill("Engine overhauled");
  page.once("dialog", (confirm) => confirm.accept());
  await dialog
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

async function openDetails(page: Page) {
  await page
    .getByRole("row")
    .filter({ hasText: ORDER_NUMBER })
    .getByRole("button", { name: "Details", exact: true })
    .click();
}

/** Starts a correction to a repair and returns its preview. */
async function previewRepair(panel: Locator): Promise<Locator> {
  await panel
    .getByRole("button", { name: "Correct component closeout", exact: true })
    .click();
  await expect(panel.getByText("Currently recorded:")).toContainText(
    "Overhauled",
  );
  await panel
    .getByLabel("Correct work performed", { exact: true })
    .selectOption({ label: "Repaired" });
  await panel
    .getByLabel("Corrected work description", { exact: true })
    .fill(REPAIR);
  await panel
    .getByLabel("Reason for tracking correction", { exact: true })
    .fill(REASON);
  await panel
    .getByRole("button", { name: "Preview correction", exact: true })
    .click();
  return panel.getByRole("region", { name: "Correction preview" });
}

/** Opens the latest correction and returns its downloaded addendum. */
async function downloadAddendum(page: Page, panel: Locator) {
  await panel.getByText("Overhauled → Repaired · Alex Morgan").click();
  const downloading = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Download correction addendum", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^${ORDER_NUMBER}-correction-[0-9a-f-]{36}\\.txt$`),
  );
  return readFile((await download.path())!, "utf8");
}
