/**
 * Responsibility: Pins inventory attachments: PDFs and photos kept through
 *   reloads and stock moves, the file-type refusal, no offline upload, and
 *   files attached while creating stock, with a failed upload retried once.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, tests/fixtures/requiredParts,
 *   src/domain/model (types).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { partsFixture } from "../fixtures/requiredParts";
import type { Snapshot } from "../../src/domain/model";

const FLIGHT_PLAN_PDF = path.resolve("tests/fixtures/icao-flight-plan.pdf");
const ICON_PNG = path.resolve("public/icon-192.png");

test("uploads photos and PDFs to inventory and keeps them after reload and stock changes", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inventory");
  await expect(
    page.getByRole("heading", { name: "Inventory", exact: true }),
  ).toBeVisible();
  await storePartsRecords(page, partsFixture());
  await page.reload();

  const stock = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await stock.getByRole("button", { name: "Details", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Stock item", exact: true });
  const section = dialog.getByRole("region", { name: "Inventory attachments" });
  await expect(section).toContainText("No attachments yet.");
  await uploadAttachment(section, FLIGHT_PLAN_PDF);
  await expect(
    section.getByRole("link", { name: "Open PDF", exact: true }),
  ).toBeVisible();
  await uploadAttachment(section, ICON_PNG);
  await expect(
    section.getByRole("img", { name: "icon-192.png", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await section
    .getByRole("link", { name: "Download icao-flight-plan.pdf", exact: true })
    .click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "icao-flight-plan.pdf",
  );
  await page.reload();
  await stock.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    section.getByRole("img", { name: "icon-192.png", exact: true }),
  ).toBeVisible();
  await expect(
    section.getByRole("link", { name: "Open PDF", exact: true }),
  ).toBeVisible();
  await uploadAttachment(section, textFile("bad.txt"));
  await expect(section.getByRole("alert")).toContainText("Choose a PDF");
  // Only flights and problem reports queue offline; uploads need a connection.
  await context.setOffline(true);
  await expect(
    section.getByRole("button", { name: "Upload attachment", exact: true }),
  ).toBeDisabled();
  await context.setOffline(false);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await stock.getByRole("button", { name: "Move stock", exact: true }).click();
  const move = page.getByRole("dialog");
  await move
    .getByLabel("Quantity (counted balance for adjustment)", { exact: true })
    .fill("2");
  await move.getByRole("button", { name: "Save", exact: true }).click();
  await expect(move).not.toBeVisible();
  await stock.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    section.getByRole("link", { name: "Open PDF", exact: true }),
  ).toBeVisible();
});

for (const retry of [false, true]) {
  test(`attaches files while creating stock${retry ? " and retries a failed upload without duplicates" : ""}`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await createLocation(page, "Attachments store");
    await page
      .getByRole("button", { name: "New stock item", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Stock item",
      exact: true,
    });
    await dialog
      .getByLabel("Part number", { exact: true })
      .fill("NEW-ATTACHMENTS");
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("New item with photos and certificates");
    const picker = dialog.getByLabel("Inventory attachment file");
    await picker.setInputFiles(textFile("wrong.txt"));
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Choose a PDF");
    await dialog
      .getByRole("button", { name: "Remove wrong.txt", exact: true })
      .click();
    await picker.setInputFiles([FLIGHT_PLAN_PDF, ICON_PNG]);
    if (retry) await failFirstRead(page, "icon-192.png");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    if (retry) await retryFailedUpload(dialog);
    else await expect(dialog).not.toBeVisible();
    await page.reload();
    const row = page.getByRole("row").filter({ hasText: "NEW-ATTACHMENTS" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Details", exact: true }).click();
    await expect(
      dialog.getByRole("link", { name: "Open PDF", exact: true }),
    ).toHaveCount(1);
    await expect(
      dialog.getByRole("img", { name: "icon-192.png", exact: true }),
    ).toHaveCount(1);
  });
}

/**
 * Replaces the stock and discrepancies in every snapshot on the device with
 * the fixture's, so the screen opens on them after a reload.
 */
async function storePartsRecords(page: Page, fixture: Snapshot) {
  const records = {
    management: fixture.management,
    discrepancies: fixture.discrepancies,
  };
  await page.evaluate(async (fields) => {
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
      s.management = fields.management;
      s.discrepancies = fields.discrepancies;
      // The stored parts view is derived from management; dropping it makes
      // the app rebuild it from the seeded records.
      delete s.partsInventory;
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
}

async function createLocation(page: Page, name: string) {
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New location", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Location name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function uploadAttachment(
  section: Locator,
  file: Parameters<Locator["setInputFiles"]>[0],
) {
  await section.getByLabel("Inventory attachment file").setInputFiles(file);
  await section
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
}

/** A plain-text upload, which inventory attachments refuse. */
function textFile(name: string) {
  return { name, mimeType: "text/plain", buffer: Buffer.from("invalid") };
}

/** Makes the browser's first read of the named file fail, as a lost upload. */
async function failFirstRead(page: Page, fileName: string) {
  await page.evaluate((name) => {
    const original = File.prototype.arrayBuffer;
    let failed = false;
    File.prototype.arrayBuffer = async function () {
      if (!failed && this.name === name) {
        failed = true;
        throw new Error("Upload interrupted");
      }
      return original.call(this);
    };
  }, fileName);
}

/**
 * The stock item is saved before its files upload, so a failed file stays
 * listed for a retry and the saved PDF is not uploaded twice.
 */
async function retryFailedUpload(dialog: Locator) {
  await expect(dialog.getByRole("alert")).toContainText(
    "The stock item was saved",
  );
  const attachments = dialog.getByRole("region", {
    name: "Inventory attachments",
    exact: true,
  });
  await expect(
    attachments.getByRole("link", { name: "Open PDF", exact: true }),
  ).toHaveCount(1);
  await expect(
    attachments.getByRole("button", {
      name: "Remove icon-192.png",
      exact: true,
    }),
  ).toBeVisible();
  await attachments
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
  await expect(
    attachments.getByRole("img", { name: "icon-192.png", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("The stock item was saved", { exact: false }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
}
