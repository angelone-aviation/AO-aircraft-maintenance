import { addSavedAddress } from "../fixtures/savedAddress";
import { test, expect } from "@playwright/test";
import { partsFixture, neededPart } from "../fixtures/requiredParts";
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
  await page.evaluate(async (fixture) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const e = cursor.result;
          if (!e) return;
          const s = e.value;
          s.management = fixture.management;
          s.inspections[0].requiredParts = [
            {
              locationUuid: "parts-location",
              stockUuid: "parts-stock",
              quantity: 6,
            },
          ];
          delete s.partsInventory;
          e.update(s);
          e.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, fixture);
  await page.goto("/inspections");
  await page.reload();
  await page
    .getByRole("button", { name: "Create PO for parts", exact: true })
    .click();
  let dialog = page.getByRole("dialog").last();
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
  await expect(
    page.getByRole("row").filter({ hasText: "Tire Vendor A" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Tire Vendor B" }),
  ).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "Tire Vendor A" })
    .getByRole("button")
    .click();
  const detail = page.getByRole("dialog").first();
  await detail.getByRole("button", { name: "Issue PO", exact: true }).click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Finalize PO", exact: true })
    .click();
  await expect(detail.getByRole("heading").first()).toContainText("Issued");
  await detail
    .getByRole("button", { name: "Record shipment", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
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
    dialog = page.getByRole("dialog").last();
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
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(detail.getByRole("heading").first()).toContainText("Closed");
  await page.reload();
  await page
    .getByRole("row")
    .filter({ hasText: "Tire Vendor A" })
    .getByRole("button")
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("link", { name: "invoice.pdf", exact: true }),
  ).toBeVisible();
  await page.goto("/inventory");
  const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await expect(row.locator("td").nth(3)).toContainText("4");
});
