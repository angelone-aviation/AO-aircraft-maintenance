import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
  const doc = await getDocument({
    data: new Uint8Array(await readFile(path!)),
    useSystemFonts: true,
  }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
  for (const phrase of [
    "AIRCRAFT STATUS SHEET",
    "Recorded aircraft status:",
    "Aircraft total time:",
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

async function statusSheetText(page: Page) {
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export status sheet", exact: true })
    .click();
  const path = await (await downloading).path();
  const doc = await getDocument({
    data: new Uint8Array(await readFile(path!)),
    useSystemFonts: true,
  }).promise;
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
  // Aircraft owners read the copy without upload or delete controls.
  await detail.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Preview owner portal", exact: true })
    .click();
  const owner = page.getByRole("region", { name: "Form 337 copies" });
  await expect(owner).toContainText("icao-flight-plan.pdf");
  await expect(owner.getByLabel("Upload Form 337 copy")).toHaveCount(0);
  await expect(
    owner.getByRole("button", { name: "Delete icao-flight-plan.pdf" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Exit owner preview", exact: true })
    .click();
  // Deleting follows maintenance permission and asks for confirmation.
  await page
    .getByRole("article")
    .filter({ hasText: "N206MA" })
    .getByRole("button", { name: /View aircraft/i })
    .click();
  page.once("dialog", (dialog) => void dialog.accept());
  await copies
    .getByRole("button", { name: "Delete icao-flight-plan.pdf", exact: true })
    .click();
  await expect(copies).toContainText("No Form 337 copies on file.");
  // Upload and deletion are audited.
  await page.goto("/history");
  for (const title of ["Aircraft · file uploaded", "Aircraft · file removed"])
    await expect(page.getByText(title, { exact: true })).toBeVisible();
});
