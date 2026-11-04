/**
 * Responsibility: Pins the inventory scanner: typed codes refused or opened,
 *   a label link opened from the Scan dialog, and a QR code read by the camera.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, qrcode.
 *
 * The camera is stubbed in the page, because Chromium builds differ: CI's
 * headless shell neither refuses the camera as the full browser does nor
 * plays the fake-device video. The stub refuses access, or streams a canvas
 * showing one QR code, which the scanner decodes with jsQR like any frame.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import QRCode from "qrcode";

const CAMERA_PART = "SCAN-CAM-1";
const TYPED_PART = "SCAN-TYPED-1";
// The scanner decodes frames scaled to at most 640 px wide.
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;
// The blank margin ISO/IEC 18004 requires around a QR code, in modules.
const QUIET_ZONE_MODULES = 4;
// The stub redraws its canvas so the stream keeps delivering frames, as a
// camera does, rather than resting on its first frame.
const REDRAW_INTERVAL_MS = 100;

/** The stubbed camera's picture: a QR code's dark modules on a frame. */
interface QrFrame {
  width: number;
  height: number;
  /** Modules per side, plus the quiet zone on each side. */
  span: number;
  /** Dark modules as [column, row], counted from the frame's top left. */
  dark: [number, number][];
  redrawMs: number;
}

test("refuses blank, foreign and unknown codes, then opens typed codes and label links", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await denyCamera(page);
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

test("reports a camera code that matches nothing, then opens the item once it exists", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await streamQrCode(page, CAMERA_PART);
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

/** Refuses every camera request, as a user who blocks the camera would. */
async function denyCamera(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(
        new DOMException("Blocked by the test", "NotAllowedError"),
      );
  });
}

/** Makes the camera a stream of `text` as a black-on-white QR code. */
async function streamQrCode(page: Page, text: string) {
  const { modules } = QRCode.create(text);
  const cells = Array.from(
    { length: modules.size ** 2 },
    (_, i): [number, number] => [
      i % modules.size,
      Math.floor(i / modules.size),
    ],
  );
  await page.addInitScript(installQrCamera, {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    span: modules.size + 2 * QUIET_ZONE_MODULES,
    dark: cells
      .filter(([column, row]) => modules.get(row, column))
      .map(([column, row]) => [
        column + QUIET_ZONE_MODULES,
        row + QUIET_ZONE_MODULES,
      ]),
    redrawMs: REDRAW_INTERVAL_MS,
  } satisfies QrFrame);
}

// Runs in the page, so it uses only its argument and browser globals. The
// code is centred in square modules as wide as the frame height allows.
function installQrCamera(qr: QrFrame) {
  const canvas = document.createElement("canvas");
  canvas.width = qr.width;
  canvas.height = qr.height;
  const context = canvas.getContext("2d")!;
  const size = Math.floor(qr.height / qr.span);
  const left = Math.floor((qr.width - qr.span * size) / 2);
  const top = Math.floor((qr.height - qr.span * size) / 2);
  const draw = () => {
    context.fillStyle = "white";
    context.fillRect(0, 0, qr.width, qr.height);
    context.fillStyle = "black";
    for (const [column, row] of qr.dark)
      context.fillRect(left + column * size, top + row * size, size, size);
  };
  let timer: number | undefined;
  navigator.mediaDevices.getUserMedia = async () => {
    draw();
    timer ??= window.setInterval(draw, qr.redrawMs);
    return canvas.captureStream();
  };
}
