/**
 * Responsibility: Pins the aircraft status sheet PDF and the Form 337 copies
 *   it lists: upload, owner view, archiving with a reason, and the audit.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, pdfjs-dist (legacy Node build), node:fs,
 *   node:path.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

test("aircraft details exports a readable PDF status sheet", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: /View aircraft/i })
    .first()
    .click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export status sheet", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /-status-\d{4}-\d{2}-\d{2}\.pdf$/,
  );
  const path = await download.path();
  expect(path).toBeTruthy();
  await download.saveAs("/tmp/aircraft-status-preview.pdf");
  const doc = await openPdf(path!);
  const text = await pdfText(doc);
  for (const phrase of [
    "AIRCRAFT STATUS SHEET",
    "Aircraft status:",
    "Aircraft status is computed from the records on this sheet.",
    "Aircraft total time:",
    "COMPONENT LIMITS",
    "INSPECTION SCHEDULES",
    "AIRWORTHINESS DIRECTIVES",
    "FORM 337 COPIES",
    "OPEN DISCREPANCIES",
    "Page 1 of",
  ])
    expect(text).toContain(phrase);
  expect(text).toContain("Hours remaining");
  expect(text).toContain("Last completed");
  expect(text).toContain("No Form 337 copies on file");
  const first = await doc.getPage(1);
  const viewport = first.getViewport({ scale: 1 });
  expect(viewport.width).toBeGreaterThan(viewport.height);
});

/** Exports the open aircraft's status sheet and returns the PDF's text. */
async function statusSheetText(page: Page) {
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export status sheet", exact: true })
    .click();
  const path = await (await downloading).path();
  return pdfText(await openPdf(path!));
}

async function openPdf(file: string): Promise<PdfDocument> {
  const data = new Uint8Array(await readFile(file));
  return getDocument({ data, useSystemFonts: true }).promise;
}

// Each page's text items are joined with spaces; the pages run together.
async function pdfText(doc: PdfDocument): Promise<string> {
  let text = "";
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
  return text;
}

test("keeps Form 337 copies on the aircraft record and lists them in the status sheet", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await page
    .getByRole("article")
    .filter({ hasText: "N206MA" })
    .getByRole("button", { name: /View aircraft/i })
    .click();
  const detail = page.getByRole("dialog", { name: "N206MA" });
  const copies = detail.getByRole("region", { name: "Form 337 copies" });
  await expect(copies).toContainText("No Form 337 copies on file.");
  // The shared attachment validation applies: PDF, JPEG, PNG or WebP only.
  await copies
    .getByLabel("Upload Form 337 copy", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/engine-g1000.csv"));
  await expect(copies.getByRole("alert")).toHaveText(
    "Choose a PDF, JPEG, PNG or WebP file.",
  );
  await copies
    .getByLabel("Upload Form 337 copy", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await expect(copies.getByRole("status")).toHaveText(
    "icao-flight-plan.pdf uploaded.",
  );
  const list = copies.getByRole("list", { name: "N206MA Form 337 copies" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("icao-flight-plan.pdf");
  await expect(
    list.getByRole("link", { name: "Open icao-flight-plan.pdf" }),
  ).toHaveAttribute("href", /^blob:/);
  // Listed in the status export.
  const text = await statusSheetText(page);
  expect(text).toContain("FORM 337 COPIES");
  expect(text).toContain("icao-flight-plan.pdf");
  expect(text).not.toContain("No Form 337 copies on file");
  // Aircraft owners read the copy without upload or archive controls.
  const openDetail = () =>
    page
      .getByRole("article")
      .filter({ hasText: "N206MA" })
      .getByRole("button", { name: /View aircraft/i })
      .click();
  const ownerPreview = async (check: () => Promise<void>) => {
    await detail.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("button", { name: "Preview owner portal", exact: true })
      .click();
    await check();
    await page
      .getByRole("button", { name: "Exit owner preview", exact: true })
      .click();
    await openDetail();
  };
  const owner = page.getByRole("region", { name: "Form 337 copies" });
  await ownerPreview(async () => {
    await expect(owner).toContainText("icao-flight-plan.pdf");
    await expect(owner.getByLabel("Upload Form 337 copy")).toHaveCount(0);
    await expect(owner.getByRole("button")).toHaveCount(0);
  });
  // Archiving follows maintenance permission and needs a reason; nothing is
  // deleted, and there is no delete control.
  await expect(copies.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  await list
    .getByRole("button", { name: "Archive icao-flight-plan.pdf", exact: true })
    .click();
  const reason = copies.getByLabel(
    "Reason for archiving icao-flight-plan.pdf",
    { exact: true },
  );
  await expect(reason).toBeFocused();
  await copies.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reason).toHaveCount(0);
  await list
    .getByRole("button", { name: "Archive icao-flight-plan.pdf", exact: true })
    .click();
  await reason.fill("Superseded by the corrected Form 337");
  await copies
    .getByRole("button", { name: "Archive copy", exact: true })
    .click();
  await expect(copies.getByRole("status")).toHaveText(
    "icao-flight-plan.pdf archived.",
  );
  await expect(copies).toContainText("No Form 337 copies on file.");
  // Archived copies are hidden until shown, then listed read-only with who
  // archived them, when and why; they can still be opened.
  const archived = copies.getByRole("list", {
    name: "N206MA archived Form 337 copies",
  });
  await expect(archived).toHaveCount(0);
  await copies
    .getByRole("switch", { name: "Show archived (1)", exact: true })
    .check();
  await expect(archived).toContainText("icao-flight-plan.pdf");
  await expect(archived).toContainText(
    "by Alex Morgan: Superseded by the corrected Form 337",
  );
  await expect(
    archived.getByRole("link", { name: "Open icao-flight-plan.pdf" }),
  ).toHaveAttribute("href", /^blob:/);
  await expect(archived.getByRole("button")).toHaveCount(0);
  // The status sheet lists current copies and counts archived ones.
  const afterArchive = await statusSheetText(page);
  expect(afterArchive).toContain("No Form 337 copies on file");
  expect(afterArchive).toContain(
    "1 archived Form 337 copy is not listed. Archived copies are kept in Angel One",
  );
  expect(afterArchive).not.toContain("icao-flight-plan.pdf");
  // Owners see only current copies.
  await ownerPreview(async () => {
    await expect(owner).toContainText("No Form 337 copies on file.");
    await expect(owner).not.toContainText("icao-flight-plan.pdf");
    await expect(owner.getByRole("switch")).toHaveCount(0);
  });
  // Upload and archiving are audited.
  await page.goto("/history");
  for (const title of ["Aircraft · file uploaded", "Aircraft · file archived"])
    await expect(page.getByText(title, { exact: true })).toBeVisible();
});
