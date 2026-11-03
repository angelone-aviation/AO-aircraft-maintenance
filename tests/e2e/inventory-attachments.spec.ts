import { test, expect } from "@playwright/test";
import { partsFixture } from "../fixtures/requiredParts";
import path from "node:path";
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
  const fixture = partsFixture();
  await page.evaluate(async (fixture) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("snapshots", "readwrite");
        const cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.management = fixture.management;
          s.discrepancies = fixture.discrepancies;
          delete s.partsInventory;
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
  }, fixture);
  await page.reload();

  const stock = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await stock.getByRole("button", { name: "Details", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Stock item", exact: true });
  const section = dialog.getByRole("region", { name: "Inventory attachments" });
  await expect(section).toContainText("No attachments yet.");
  await section
    .getByLabel("Inventory attachment file")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await section
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
  await expect(
    section.getByRole("link", { name: "Open PDF", exact: true }),
  ).toBeVisible();
  await section
    .getByLabel("Inventory attachment file")
    .setInputFiles(path.resolve("public/icon-192.png"));
  await section
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
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
  await section.getByLabel("Inventory attachment file").setInputFiles({
    name: "bad.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("invalid"),
  });
  await section
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
  await expect(section.getByRole("alert")).toContainText("Choose a PDF");
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
    await page.goto("/inventory");
    await page
      .getByRole("button", { name: "New location", exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Location name", { exact: true })
      .fill("Attachments store");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "New stock item", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Stock item", exact: true });
    await dialog
      .getByLabel("Part number", { exact: true })
      .fill("NEW-ATTACHMENTS");
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("New item with photos and certificates");
    const picker = dialog.getByLabel("Inventory attachment file");
    await picker.setInputFiles({
      name: "wrong.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("invalid"),
    });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Choose a PDF");
    await dialog
      .getByRole("button", { name: "Remove wrong.txt", exact: true })
      .click();
    await picker.setInputFiles([
      path.resolve("tests/fixtures/icao-flight-plan.pdf"),
      path.resolve("public/icon-192.png"),
    ]);
    if (retry)
      await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        let failed = false;
        File.prototype.arrayBuffer = async function () {
          if (!failed && this.name === "icon-192.png") {
            failed = true;
            throw new Error("Upload interrupted");
          }
          return original.call(this);
        };
      });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    if (retry) {
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
    } else await expect(dialog).not.toBeVisible();
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
