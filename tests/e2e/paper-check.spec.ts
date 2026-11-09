/**
 * Responsibility: Pins the monthly paper check: the button on the aircraft
 *   detail and in the flight log, the month picker, and the saved CSV and
 *   PDF with the flight and sign-off tables.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, pdfjs-dist (legacy Node build), node:fs.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MONTH = "2026-03";

test("saves an aircraft's paper check for a month as CSV and PDF", async ({
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
  await page
    .getByRole("button", { name: "Paper check (month)", exact: true })
    .click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Paper check" });
  await dialog.getByLabel("Month", { exact: true }).fill(MONTH);
  const csv = await saved(page, () =>
    dialog.getByRole("button", { name: "Save CSV", exact: true }).click(),
  );
  expect(csv.name).toMatch(/^N\d+[A-Z]*-paper-check-2026-03\.csv$/);
  const lines = csv.text.split("\r\n");
  expect(lines[0]).toContain('"Section","Date","Pilot","Hobbs start"');
  expect(lines.at(-1)).toContain('"Totals"');
  const pdf = await saved(page, () =>
    dialog.getByRole("button", { name: "Save PDF", exact: true }).click(),
  );
  expect(pdf.name).toMatch(/-paper-check-2026-03\.pdf$/);
  const text = await pdfText(pdf.path);
  for (const phrase of [
    "PAPER CHECK | March 2026",
    "FLIGHTS",
    "Hobbs start",
    "Checked",
    "Month totals (accepted flights):",
    "MAINTENANCE SIGN-OFFS",
    "None recorded",
    "the signed paper record governs.",
  ])
    expect(text).toContain(phrase);
});

test("offers the paper check with an aircraft choice in the flight log", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flights");
  await page
    .getByRole("button", { name: "Paper check (month)", exact: true })
    .click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Paper check" });
  await dialog.getByLabel("Aircraft", { exact: true }).selectOption({
    label: "N182MA",
  });
  await dialog.getByLabel("Month", { exact: true }).fill(MONTH);
  const csv = await saved(page, () =>
    dialog.getByRole("button", { name: "Save CSV", exact: true }).click(),
  );
  expect(csv.name).toBe("N182MA-paper-check-2026-03.csv");
});

/** Runs `trigger` and returns the download it causes: name, path and text. */
async function saved(page: Page, trigger: () => Promise<void>) {
  const downloading = page.waitForEvent("download");
  await trigger();
  const download = await downloading;
  const path = (await download.path())!;
  return {
    name: download.suggestedFilename(),
    path,
    text: await readFile(path, "utf8"),
  };
}

// Each page's text items are joined with spaces; the pages run together.
async function pdfText(file: string): Promise<string> {
  const data = new Uint8Array(await readFile(file));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
  return text;
}
