import { test, expect } from "@playwright/test";
import { jsPDF } from "jspdf";

test("renders a linked PDF page and supports tablet navigation, zoom and reload without a native viewer", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Shipping Safari lacks stream async iteration even where test WebKit has it.
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
      value: undefined,
      configurable: true,
    });
  });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  const pdf = new jsPDF();
  for (let i = 1; i <= 3; i++) {
    if (i > 1) pdf.addPage();
    pdf.text(`Reader test page ${i}`, 20, 30);
  }
  await page.goto("/aircraft");
  await page
    .getByRole("button", { name: "Manuals", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Upload manual", exact: true })
    .click();
  const upload = page.getByRole("dialog", {
    name: "Upload reference manual",
    exact: true,
  });
  await upload.getByLabel("Manual title", { exact: true }).fill("Reader test");
  await upload.getByLabel("Document number", { exact: true }).fill("TEST");
  await upload
    .getByLabel("Revision / temporary revisions", { exact: true })
    .fill("1");
  await upload.getByLabel("PDF manual", { exact: true }).setInputFiles({
    name: "reader.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(pdf.output("arraybuffer")),
  });
  await upload
    .getByRole("button", { name: "Save manual", exact: true })
    .click();
  await expect(upload).not.toBeVisible();
  await page.goto("/manuals");
  const href = await page
    .getByRole("link", { name: "Open manual", exact: true })
    .getAttribute("href");
  await page.goto(href!.split("?")[0] + "?page=2");
  const canvas = page.locator(".pdf-reader canvas");
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Reader test — PDF page 2",
  );
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText("Page text", { exact: true })).toBeVisible();
  await expect(page.locator(".pdf-reader [role=alert]")).toHaveCount(0);
  await page.getByText("Page text", { exact: true }).click();
  await expect(page.locator(".pdf-reader-text")).toContainText(
    "Reader test page 2",
  );
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Reader test — PDF page 3",
  );
  await expect(
    page.getByRole("button", { name: "Next page", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Reader test — PDF page 2",
  );
  await page.getByLabel("PDF viewer page number").fill("1");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Reader test — PDF page 1",
  );
  await page.getByLabel("PDF zoom").selectOption("2");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width * c.height))
    .toBeLessThanOrEqual(4_000_000);
  await page.reload();
  await expect(canvas).toHaveAttribute(
    "aria-label",
    "Reader test — PDF page 2",
  );
});

test("renders visible scanned manual content with the packaged image decoders", async ({
  page,
}) => {
  test.skip(
    !process.env.PDF_READER_MANUAL,
    "Set PDF_READER_MANUAL to a local scanned PDF and PDF_READER_PAGE to its page (default 198).",
  );
  test.setTimeout(120000);
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/aircraft");
  await page
    .getByRole("button", { name: "Manuals", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Upload manual", exact: true })
    .click();
  const upload = page.getByRole("dialog", {
    name: "Upload reference manual",
    exact: true,
  });
  await upload
    .getByLabel("Manual title", { exact: true })
    .fill("Scanned manual");
  await upload.getByLabel("Document number", { exact: true }).fill("SCAN");
  await upload
    .getByLabel("Revision / temporary revisions", { exact: true })
    .fill("1");
  await upload
    .getByLabel("PDF manual", { exact: true })
    .setInputFiles(process.env.PDF_READER_MANUAL!);
  await upload
    .getByRole("button", { name: "Save manual", exact: true })
    .click();
  await expect(upload).not.toBeVisible({ timeout: 90000 });
  await page.goto("/manuals");
  const href = await page
    .getByRole("link", { name: "Open manual", exact: true })
    .getAttribute("href");
  const decoder = page.waitForResponse((r) => r.url().endsWith("/jbig2.wasm"));
  await page.goto(href!.split("?")[0] + "?page=" + (process.env.PDF_READER_PAGE || "198"));
  expect((await decoder).ok()).toBeTruthy();
  const canvas = page.locator(".pdf-reader canvas");
  await expect(canvas).toBeVisible({ timeout: 30000 });
  // A canvas element and correct page label alone do not prove PDF rendering.
  await expect
    .poll(() =>
      canvas.evaluate((c: HTMLCanvasElement) => {
        const data = c
          .getContext("2d")!
          .getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            data[i + 3] > 0 &&
            (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230)
          )
            ink++;
        return ink;
      }),
    )
    .toBeGreaterThan(1000);
  await expect(page.locator(".pdf-reader [role=alert]")).toHaveCount(0);
  await canvas.screenshot({ path: "test-results/scanned-manual-page-198.png" });
});
