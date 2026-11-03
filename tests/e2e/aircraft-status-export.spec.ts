import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
    "OPEN DISCREPANCIES",
    "Page 1 of",
  ])
    expect(text).toContain(phrase);
  expect(text).toContain("Hours remaining");
  expect(text).toContain("Last completed");
  const first = await doc.getPage(1);
  const viewport = first.getViewport({ scale: 1 });
  expect(viewport.width).toBeGreaterThan(viewport.height);
});
