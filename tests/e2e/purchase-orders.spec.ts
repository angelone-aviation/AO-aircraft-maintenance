/**
 * Responsibility: Pins purchase orders from an inspection's required parts:
 *   the shortage split across two vendors, then one PO issued, shipped,
 *   received in two parts, given documents and closed, with its history kept.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures (requiredParts,
 *   savedAddress), src/domain (model, requiredParts types).
 */
import { test, expect, type Page } from "@playwright/test";
import { addSavedAddress } from "../fixtures/savedAddress";
import { partsFixture } from "../fixtures/requiredParts";
import type { Snapshot } from "../../src/domain/model";
import type { RequiredPart } from "../../src/domain/requiredParts";

test("inspection vendor POs ship, receive once, attach documents and retain history", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/purchase-orders");
  await expect(
    page.getByRole("heading", { name: "Purchase orders", exact: true }),
  ).toBeVisible();
  const fixture = partsFixture();
  for (const location of fixture.management ?? []) {
    if (location.kind === "location")
      location.address = `${location.name} delivery address`;
  }
  await storeRequiredParts(page, fixture.management, [
    { locationUuid: "parts-location", stockUuid: "parts-stock", quantity: 6 },
  ]);
  await page.goto("/inspections");
  await page.reload();
  await page
    .getByRole("button", { name: "Create PO for parts", exact: true })
    .click();
  // Dialogs stack: the last is on top, the first is the PO's detail.
  const dialog = page.getByRole("dialog").last();
  await expect(
    dialog.getByLabel("Shipping address — Street address"),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Part 1 inventory location")
    .selectOption("parts-location");
  await dialog.getByLabel("Part 1 stock item").selectOption("parts-stock");
  await dialog.getByLabel("Vendor", { exact: true }).fill("Tire Vendor A");
  await dialog.getByRole("button", { name: "Quick add", exact: true }).click();
  await addSavedAddress(
    page,
    dialog,
    "Shipping address",
    "Main receiving",
    "Main hangar delivery",
  );
  // 6 required, 2 in stock: 4 to order.
  await expect(
    dialog.getByLabel("Part 1 quantity", { exact: true }),
  ).toHaveValue("4");
  await dialog.getByLabel("Part 1 quantity", { exact: true }).fill("2");
  await dialog
    .getByRole("button", { name: "Split part 1 across vendors" })
    .click();
  await dialog.getByLabel("Part 2 quantity", { exact: true }).fill("2");
  await dialog
    .getByLabel("Part 2 vendor (optional override)")
    .fill("Tire Vendor B");
  await dialog.getByRole("button", { name: "Quick add", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save draft PO", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("link", { name: "Purchase orders", exact: true })
    .click();
  await expect(vendorRow(page, "Tire Vendor A")).toBeVisible();
  await expect(vendorRow(page, "Tire Vendor B")).toBeVisible();
  await vendorRow(page, "Tire Vendor A").getByRole("button").click();
  const detail = page.getByRole("dialog").first();
  await detail.getByRole("button", { name: "Issue PO", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Finalize PO", exact: true })
    .click();
  await expect(detail.getByRole("heading").first()).toContainText("Issued");
  await detail
    .getByRole("button", { name: "Record shipment", exact: true })
    .click();
  await dialog.getByLabel("Carrier", { exact: true }).fill("UPS");
  await dialog.getByLabel("Tracking number").fill("TRACK-123");
  await dialog.getByLabel("FILTER-1 quantity shipped").fill("2");
  await dialog
    .getByRole("button", { name: "Save shipment", exact: true })
    .click();
  await expect(detail.getByRole("heading").first()).toContainText("Shipped");
  for (let i = 0; i < 2; i++) {
    await detail
      .getByRole("button", { name: "Receive parts", exact: true })
      .click();
    await dialog.getByLabel("Invoice number", { exact: true }).fill(`INV-${i}`);
    await dialog.getByLabel("FILTER-1 quantity received").fill("1");
    await dialog
      .getByRole("button", {
        name: "Confirm receipt into inventory",
        exact: true,
      })
      .click();
    await expect(detail.getByRole("heading").first()).toContainText(
      i === 0 ? "Partially received" : "Received",
    );
  }
  await detail.getByLabel("Attach files to").selectOption({ index: 1 });
  await detail.getByLabel("PO attachment", { exact: true }).setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nTest"),
  });
  await expect(
    detail.getByRole("link", { name: "invoice.pdf", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await detail
    .getByRole("button", { name: "Save PO PDF", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(/PO-.*\.pdf/);
  await detail.getByRole("button", { name: "Close PO", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(detail.getByRole("heading").first()).toContainText("Closed");
  await page.reload();
  await vendorRow(page, "Tire Vendor A").getByRole("button").click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("link", { name: "invoice.pdf", exact: true }),
  ).toBeVisible();
  // The 2 in stock plus Vendor A's 2 received; Vendor B's order is a draft.
  await page.goto("/inventory");
  const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await expect(row.locator("td").nth(3)).toContainText("4");
});

/**
 * Replaces the management records in every snapshot on the device and puts
 * `requiredParts` on the first inspection.
 */
async function storeRequiredParts(
  page: Page,
  management: Snapshot["management"],
  requiredParts: RequiredPart[],
) {
  await page.evaluate(
    async (records) => {
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
        s.management = records.management;
        s.inspections[0].requiredParts = records.requiredParts;
        // The stored parts view is derived from management; dropping it
        // makes the app rebuild it from the seeded records.
        delete s.partsInventory;
        entry.update(s);
        entry.continue();
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { management, requiredParts },
  );
}

function vendorRow(page: Page, vendor: string) {
  return page.getByRole("row").filter({ hasText: vendor });
}
