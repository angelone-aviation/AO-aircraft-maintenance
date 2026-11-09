/**
 * Responsibility: Pins the per-aircraft records package: who sees the export,
 *   the ZIP's name and files, the README, the CSV row counts, the Form 337
 *   copy it carries and the readable records.pdf.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, fflate, pdfjs-dist (legacy Node build),
 *   node:fs, node:path, tests/fixtures/icao-flight-plan.pdf.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

const FORM_337 = "tests/fixtures/icao-flight-plan.pdf";
const EXPORT = { name: "Export records package", exact: true };

test("maintenance users export a complete records package for one aircraft", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await openAircraft(page);
  const detail = page.getByRole("dialog", { name: "N206MA" });
  // A Form 337 copy on file travels with the package.
  const copies = detail.getByRole("region", { name: "Form 337 copies" });
  await copies
    .getByLabel("Upload Form 337 copy", { exact: true })
    .setInputFiles(path.resolve(FORM_337));
  await expect(copies.getByRole("status")).toHaveText(
    "icao-flight-plan.pdf uploaded.",
  );
  const downloading = page.waitForEvent("download");
  await detail.getByRole("button", EXPORT).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^N206MA-records-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  await expect(detail.getByRole("status").last()).toHaveText(
    "Records package saved.",
  );
  const file = await download.path();
  const files = unzipSync(new Uint8Array(await readFile(file!)));
  const names = Object.keys(files).sort();
  for (const name of [
    "README.txt",
    "records.pdf",
    "status-overview.csv",
    "status-inspections.csv",
    "flights.csv",
    "discrepancies.csv",
    "work-orders.csv",
    "ad-compliance.csv",
    "components.csv",
    "component-requirements.csv",
    "form-337.csv",
    "change-log.csv",
  ])
    expect(names).toContain(name);
  const copy = names.find((n) =>
    /^form-337\/\d{4}-\d{2}-\d{2}-icao-flight-plan\.pdf$/.test(n),
  );
  expect(copy).toBeTruthy();
  expect(files[copy!].length).toBe((await readFile(FORM_337)).length);
  const readme = strFromU8(files["README.txt"]);
  expect(readme).toContain("Aircraft: N206MA - Cessna 206 Stationair");
  expect(readme).toContain("Flight Program: Mission operations");
  expect(readme).toMatch(
    /Generated: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC by Alex Morgan/,
  );
  expect(readme).toContain("14 CFR 91.417(c)");
  expect(readme).toContain(
    "status-inspections.csv - Inspection schedules (2 rows).",
  );
  expect(readme).toContain("flights.csv - Flights (0 rows).");
  expect(readme).toContain("form-337.csv - Form 337 copies on file (1 row).");
  expect(readme).toMatch(/SKIPPED FILES\nNone\.\n$/);
  // One header line plus the records; a placeholder counts as a line too.
  expect(csvLines(files["status-inspections.csv"])).toBe(3);
  expect(csvLines(files["flights.csv"])).toBe(2);
  expect(strFromU8(files["flights.csv"])).toContain('"No flights recorded"');
  expect(csvLines(files["form-337.csv"])).toBe(2);
  expect(strFromU8(files["form-337.csv"])).toContain("icao-flight-plan.pdf");
  expect(csvLines(files["change-log.csv"])).toBeGreaterThanOrEqual(2);
  expect(strFromU8(files["change-log.csv"])).toContain(
    "Aircraft · file uploaded",
  );
  const doc = await getDocument({
    data: files["records.pdf"],
    useSystemFonts: true,
  }).promise;
  const text = await pdfText(doc);
  for (const phrase of [
    "N206MA | AIRCRAFT RECORDS PACKAGE",
    "AIRCRAFT OVERVIEW",
    "INSPECTION SCHEDULES",
    "FLIGHTS",
    "No flights recorded",
    "WORK ORDERS",
    "AD COMPLIANCE HISTORY",
    "COMPONENT REQUIREMENTS",
    "FORM 337 COPIES ON FILE",
    "icao-flight-plan.pdf",
    "CHANGE LOG",
    "Aircraft · file uploaded",
    "Page 1 of",
  ])
    expect(text).toContain(phrase);
  const orientations = await pageOrientations(doc);
  expect(orientations[0]).toBe("landscape");
  expect(orientations).toContain("portrait");
  // Owners keep the status sheet only.
  await detail.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Preview owner portal", exact: true })
    .click();
  await expect(
    page
      .getByRole("button", { name: "Export status sheet", exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole("button", EXPORT)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Exit owner preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Preview owner portal", exact: true }),
  ).toBeVisible();
  // The History screen exports the aircraft it is filtered to.
  await page.goto("/history");
  await expect(page.getByRole("button", EXPORT)).toHaveCount(0);
  await page.getByLabel("Aircraft", { exact: true }).selectOption("demo-208");
  await expect(page.getByRole("button", EXPORT)).toBeVisible();
  const second = page.waitForEvent("download");
  await page.getByRole("button", EXPORT).click();
  expect((await second).suggestedFilename()).toMatch(/^N208MA-records-/);
});

async function openAircraft(page: Page) {
  await page
    .getByRole("article")
    .filter({ hasText: "N206MA" })
    .getByRole("button", { name: /View aircraft/i })
    .click();
}

function csvLines(bytes: Uint8Array): number {
  return strFromU8(bytes).split("\r\n").length;
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

async function pageOrientations(doc: PdfDocument): Promise<string[]> {
  const orientations: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
    orientations.push(width > height ? "landscape" : "portrait");
  }
  return orientations;
}
