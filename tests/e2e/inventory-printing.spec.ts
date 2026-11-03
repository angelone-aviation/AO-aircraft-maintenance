import { test, expect } from "@playwright/test";
import { partsFixture } from "../fixtures/requiredParts";
import { workOrderComponent } from "../fixtures/workOrders";
import sharp from "sharp";
import jsQR from "jsqr";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

test("prints two-inch labels and tags with decodable item links, including installed components", async ({
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
  fixture.management!.push(workOrderComponent());
  await page.evaluate(async (fixture) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.management = fixture.management;
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
  const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await expect(
    row.getByRole("button", { name: "Print Tag", exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Print Label", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Print Label", exact: true });
  await expect(
    dialog.getByRole("button", { name: "Print", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("QR website address")
    .fill("https://stock.example.test");
  await expect(
    dialog.getByRole("button", { name: "Print", exact: true }),
  ).toBeEnabled();
  let frame = page.frameLocator('iframe[title="Print preview"]');
  await expect(frame.getByText("FILTER-1", { exact: true })).toBeVisible();
  await expect(frame.getByText("SERIAL NO.", { exact: true })).toHaveCount(0);
  const svg = await frame
    .locator("svg")
    .evaluate((el) => new XMLSerializer().serializeToString(el));
  const pixels = await sharp(Buffer.from(svg), { density: 300 })
    .resize(600, 600)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = jsQR(
    new Uint8ClampedArray(pixels.data),
    pixels.info.width,
    pixels.info.height,
  );
  expect(decoded?.data).toBe(
    "https://stock.example.test/inventory?item=parts-stock&program=demo-program",
  );
  const preview = await page
    .locator('iframe[title="Print preview"]')
    .getAttribute("srcdoc");
  const printPage = await context.newPage();
  await printPage.setContent(preview!);
  const pdf = await printPage.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  const pdfDocument = await getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
  }).promise;
  expect(pdfDocument.numPages).toBe(1);
  const pdfPage = await pdfDocument.getPage(1);
  expect(pdfPage.view[2]).toBeCloseTo(144, 0);
  expect(pdfPage.view[3]).toBeCloseTo(90, 0);
  await pdfDocument.cleanup();
  await printPage.close();
  await frame.locator("body").evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = "yes";
    };
  });
  await dialog.getByRole("button", { name: "Print", exact: true }).click();
  await expect(frame.locator("body")).toHaveAttribute("data-printed", "yes");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const target = new URL(decoded!.data);
  await page.goto(target.pathname + target.search);
  await expect(
    page
      .getByRole("dialog", { name: "Stock item", exact: true })
      .getByLabel("Part number", { exact: true }),
  ).toHaveValue("FILTER-1");
  await page
    .getByRole("dialog", { name: "Stock item", exact: true })
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page).toHaveURL(/\/inventory$/);
  await page.goto("/inventory?item=engine&program=demo-program");
  const details = page.getByRole("dialog", { name: "Stock item", exact: true });
  await expect(
    details.getByLabel("Serial number", { exact: true }),
  ).toHaveValue("SN");
  await details.getByRole("button", { name: "Print Tag", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Print Tag", exact: true });
  await expect(dialog.getByLabel("QR website address")).toHaveValue(
    "https://stock.example.test",
  );
  await expect(
    dialog.getByRole("button", { name: "Print", exact: true }),
  ).toBeEnabled();
  frame = page.frameLocator('iframe[title="Print preview"]');
  await expect(frame.locator("h1")).toContainText("PARTS REMOVAL");
  await expect(frame.getByText("SN", { exact: true })).toBeVisible();
  await page
    .locator('iframe[title="Print preview"]')
    .screenshot({ path: "/tmp/inventory-tag-preview.png" });
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await details
    .getByRole("button", { name: "Print Label", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Print Label", exact: true });
  await expect(
    dialog.getByRole("button", { name: "Print", exact: true }),
  ).toBeEnabled();
  await expect(frame.getByText("SERIAL NO.", { exact: true })).toBeVisible();
  await expect(frame.getByText("SN", { exact: true })).toBeVisible();
  await dialog.getByLabel("Sticker length (inches)").fill("1");
  await expect(
    dialog.getByRole("button", { name: "Print", exact: true }),
  ).toBeEnabled();
  await dialog.getByLabel("QR website address").fill("http://localhost:5173");
  await expect(
    dialog.getByRole("button", { name: "Print", exact: true }),
  ).toBeDisabled();
  await page.goto("/inventory?item=missing&program=demo-program");
  await expect(
    page.getByText("This inventory item is not available", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
