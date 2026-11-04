/**
 * Responsibility: Pins the inventory scanner: typed codes refused or opened,
 *   a label link opened from the Scan dialog, and a QR code read by the camera.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, qrcode, node:fs/promises, node:path.
 *
 * Chromium's fake camera plays a generated still of one QR code. Camera access
 * is denied unless a test grants it, so the typed-code test sees no camera.
 */
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";

const CAMERA_PART = "SCAN-CAM-1";
const TYPED_PART = "SCAN-TYPED-1";
// A 4:2:0 frame needs even dimensions; the scanner decodes 640 px wide frames.
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;
// The blank margin ISO/IEC 18004 requires around a QR code, in modules.
const QUIET_ZONE_MODULES = 4;
// Black and white in video-range luma (BT.601); chroma 128 adds no colour.
const LUMA_BLACK = 16;
const LUMA_WHITE = 235;
const CHROMA_NEUTRAL = 128;

// Adds the fake camera to the configured browser; Chromium reads the video
// file from its command line, so it is written before the browser starts.
const test = base.extend({
  launchOptions: [
    async ({ launchOptions }, use, workerInfo) => {
      const { outputDir } = workerInfo.project;
      const video = path.join(outputDir, "scan-camera.y4m");
      await mkdir(outputDir, { recursive: true });
      await writeFile(video, qrVideo(CAMERA_PART));
      await use({
        ...launchOptions,
        args: [
          ...(launchOptions.args ?? []),
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-video-capture=${video}`,
        ],
      });
    },
    { scope: "worker" },
  ],
});

test("refuses blank, foreign and unknown codes, then opens typed codes and label links", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await createStockItem(page, TYPED_PART);
  await page.goto("/scan");
  await expect(page.getByRole("alert")).toHaveText(
    "Camera access was denied. Allow camera access for this site in your browser settings, or enter the code manually.",
  );
  const form = page.getByRole("form", { name: "Enter a label manually" });
  await enterCode(page, "");
  await expect(form.getByRole("alert")).toHaveText(
    "Scan a label or enter a code.",
  );
  await enterCode(page, "https://example.test/parts?item=1");
  await expect(form.getByRole("alert")).toHaveText(
    "This QR code is not an Angel One inventory label.",
  );
  await enterCode(page, "NO-SUCH-PART");
  await expect(form.getByRole("alert")).toHaveText(
    "No inventory item you can access matches “NO-SUCH-PART”.",
  );
  // Part and serial numbers match whatever their case.
  await enterCode(page, TYPED_PART.toLowerCase());
  await expectStockItem(page, TYPED_PART);
  const item = new URL(page.url()).searchParams.get("item");
  await closeDialog(page);
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const scan = page.getByRole("dialog", { name: "Scan inventory label" });
  await enterCode(
    scan,
    `https://labels.example.test/inventory?item=${item}&program=demo-program`,
  );
  await expect(scan).not.toBeVisible();
  await expectStockItem(page, TYPED_PART);
});

test.describe("with camera access", () => {
  test.use({ permissions: ["camera"] });

  test("reports a camera code that matches nothing, then opens the item once it exists", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await page.goto("/scan");
    // Characterizes current behaviour: the camera's refusal shows under the
    // typed-code form, and the camera keeps running.
    await expect(
      page
        .getByRole("form", { name: "Enter a label manually" })
        .getByRole("alert"),
    ).toHaveText(`No inventory item you can access matches “${CAMERA_PART}”.`);
    await expect(
      page.getByLabel("Camera preview for scanning inventory labels"),
    ).toBeVisible();
    await createStockItem(page, CAMERA_PART);
    await page.goto("/scan");
    await expectStockItem(page, CAMERA_PART);
  });
});

/** Creates a storage location and one stock item in it, on /inventory. */
async function createStockItem(page: Page, partNumber: string) {
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New location", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Location name", { exact: true }).fill("Scan store");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "New stock item", exact: true })
    .click();
  await dialog.getByLabel("Part number", { exact: true }).fill(partNumber);
  await dialog.getByLabel("Description", { exact: true }).fill("Scan target");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** Types a code into the scanner on the page or in the Scan dialog. */
async function enterCode(scope: Page | Locator, code: string) {
  await scope.getByLabel("Enter code manually", { exact: true }).fill(code);
  await scope.getByRole("button", { name: "Open item", exact: true }).click();
}

/** Expects the inventory screen to have opened the stock item's details. */
async function expectStockItem(page: Page, partNumber: string) {
  await expect(page).toHaveURL(/\/inventory\?item=/);
  await expect(
    page
      .getByRole("dialog", { name: "Stock item", exact: true })
      .getByLabel("Part number", { exact: true }),
  ).toHaveValue(partNumber);
}

async function closeDialog(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

/**
 * A one-frame YUV4MPEG2 video of `text` as a black-on-white QR code, centred;
 * Chromium's fake camera repeats the frame.
 */
function qrVideo(text: string): Buffer {
  const { modules } = QRCode.create(text);
  const scale = Math.floor(
    FRAME_HEIGHT / (modules.size + 2 * QUIET_ZONE_MODULES),
  );
  const side = modules.size * scale;
  const left = Math.floor((FRAME_WIDTH - side) / 2);
  const top = Math.floor((FRAME_HEIGHT - side) / 2);
  const luma = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT, LUMA_WHITE);
  for (let pixel = 0; pixel < side * side; pixel++) {
    const row = Math.floor(pixel / side);
    const column = pixel % side;
    if (modules.get(Math.floor(row / scale), Math.floor(column / scale)))
      luma[(top + row) * FRAME_WIDTH + left + column] = LUMA_BLACK;
  }
  // Two quarter-size chroma planes, U then V.
  const chroma = Buffer.alloc((FRAME_WIDTH * FRAME_HEIGHT) / 2, CHROMA_NEUTRAL);
  const header = `YUV4MPEG2 W${FRAME_WIDTH} H${FRAME_HEIGHT} F30:1 Ip A1:1 C420jpeg\nFRAME\n`;
  return Buffer.concat([Buffer.from(header), luma, chroma]);
}
