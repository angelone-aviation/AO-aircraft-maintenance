/**
 * Responsibility: Pins inventory labels and tags: the QR code decodes to the
 *   item's link, the label prints on one 2 × 1.25 in page, the link opens the
 *   item, and a localhost address or a missing item is refused.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, sharp, jsqr, pdfjs-dist, tests/fixtures
 *   (requiredParts, workOrders), src/domain/model (types).
 */
import {
  test,
  expect,
  type BrowserContext,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import sharp from "sharp";
import jsQR from "jsqr";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { partsFixture } from "../fixtures/requiredParts";
import { workOrderComponent } from "../fixtures/workOrders";
import type { Snapshot } from "../../src/domain/model";

const QR_SITE = "https://stock.example.test";
const PRINT_PREVIEW = 'iframe[title="Print preview"]';
// The default label is 2 in wide and 1.25 in long, at 72 PDF points an inch.
const LABEL_WIDTH_PT = 144;
const LABEL_HEIGHT_PT = 90;

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
  await storeManagement(page, fixture.management);
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await expect(
    row.getByRole("button", { name: "Print Tag", exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Print Label", exact: true }).click();
  const label = page.getByRole("dialog", { name: "Print Label", exact: true });
  await expect(printButton(label)).toBeDisabled();
  await label.getByLabel("QR website address").fill(QR_SITE);
  await expect(printButton(label)).toBeEnabled();
  const frame = page.frameLocator(PRINT_PREVIEW);
  await expect(frame.getByText("FILTER-1", { exact: true })).toBeVisible();
  await expect(frame.getByText("SERIAL NO.", { exact: true })).toHaveCount(0);
  const decoded = await decodeQr(frame);
  expect(decoded?.data).toBe(
    `${QR_SITE}/inventory?item=parts-stock&program=demo-program`,
  );
  const preview = await page.locator(PRINT_PREVIEW).getAttribute("srcdoc");
  const sheet = await printToPdf(context, preview!);
  expect(sheet.pages).toBe(1);
  expect(sheet.width).toBeCloseTo(LABEL_WIDTH_PT, 0);
  expect(sheet.height).toBeCloseTo(LABEL_HEIGHT_PT, 0);
  // Stands in for the browser's print dialog, which would block the test.
  await frame.locator("body").evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = "yes";
    };
  });
  await printButton(label).click();
  await expect(frame.locator("body")).toHaveAttribute("data-printed", "yes");
  await label
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
  const tag = page.getByRole("dialog", { name: "Print Tag", exact: true });
  await expect(tag.getByLabel("QR website address")).toHaveValue(QR_SITE);
  await expect(printButton(tag)).toBeEnabled();
  await expect(frame.locator("h1")).toContainText("PARTS REMOVAL");
  await expect(frame.getByText("SN", { exact: true })).toBeVisible();
  await page
    .locator(PRINT_PREVIEW)
    .screenshot({ path: "/tmp/inventory-tag-preview.png" });
  await tag.getByRole("button", { name: "Close dialog", exact: true }).click();
  await details
    .getByRole("button", { name: "Print Label", exact: true })
    .click();
  await expect(printButton(label)).toBeEnabled();
  await expect(frame.getByText("SERIAL NO.", { exact: true })).toBeVisible();
  await expect(frame.getByText("SN", { exact: true })).toBeVisible();
  await label.getByLabel("Sticker length (inches)").fill("1");
  await expect(printButton(label)).toBeEnabled();
  // A phone scanning the label cannot open this device's localhost.
  await label.getByLabel("QR website address").fill("http://localhost:5173");
  await expect(printButton(label)).toBeDisabled();
  await page.goto("/inventory?item=missing&program=demo-program");
  await expect(
    page.getByText("This inventory item is not available", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/**
 * Replaces the management records in every snapshot on the device, so the
 * screen opens on them after a reload.
 */
async function storeManagement(page: Page, management: Snapshot["management"]) {
  await page.evaluate(async (records) => {
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
      s.management = records;
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
  }, management);
}

function printButton(dialog: Locator) {
  return dialog.getByRole("button", { name: "Print", exact: true });
}

/** Rasterizes the preview's QR code and decodes it, or null if unreadable. */
async function decodeQr(frame: FrameLocator) {
  const svg = await frame
    .locator("svg")
    .evaluate((el) => new XMLSerializer().serializeToString(el));
  const pixels = await sharp(Buffer.from(svg), { density: 300 })
    .resize(600, 600)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(
    new Uint8ClampedArray(pixels.data),
    pixels.info.width,
    pixels.info.height,
  );
}

/** Prints the preview's HTML to PDF and measures its first page in points. */
async function printToPdf(context: BrowserContext, html: string) {
  const printPage = await context.newPage();
  await printPage.setContent(html);
  const pdf = await printPage.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  const pdfDocument = await getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
  }).promise;
  const pdfPage = await pdfDocument.getPage(1);
  const sheet = {
    pages: pdfDocument.numPages,
    width: pdfPage.view[2],
    height: pdfPage.view[3],
  };
  await pdfDocument.cleanup();
  await printPage.close();
  return sheet;
}
