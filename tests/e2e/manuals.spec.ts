import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
test("uploads a manual from an aircraft, persists it and opens a saved inspection page reference", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
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
    .fill("Cessna 441 Maintenance Manual");
  await upload
    .getByLabel("Document number", { exact: true })
    .fill("D2518-15-13");
  await upload
    .getByLabel("Revision / temporary revisions", { exact: true })
    .fill("15; TR 5-1 and 5-2");
  const actualManual = path.resolve(
    "16802162-Cessna_441_Maintenance_Manual_D2518-15-13_Mm.pdf",
  );
  const usesActualManual = fs.existsSync(actualManual);
  await upload
    .getByLabel("PDF manual", { exact: true })
    .setInputFiles(
      usesActualManual
        ? actualManual
        : path.resolve("tests/fixtures/icao-flight-plan.pdf"),
    );
  await upload
    .getByRole("button", { name: "Save manual", exact: true })
    .click();
  await expect(upload).not.toBeVisible({ timeout: 90000 });
  await page.goto("/manuals");
  await expect(
    page.getByRole("cell", {
      name: "Cessna 441 Maintenance Manual D2518-15-13",
    }),
  ).toBeVisible();
  if (usesActualManual)
    await expect(page.getByText("2,937 pages · 98.5 MB")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Open manual", exact: true }),
  ).toBeVisible();
  await page.goto("/inspections");
  const row = page
    .getByRole("row")
    .filter({ hasText: "100-hour inspection" })
    .first();
  await row.getByRole("button", { name: "Details", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor
    .getByLabel("Reference library manual", { exact: true })
    .selectOption({
      label: "Cessna 441 Maintenance Manual · 15; TR 5-1 and 5-2",
    });
  await editor.getByLabel("Manual section", { exact: true }).fill("5-12-02");
  await editor.getByLabel("Printed page label", { exact: true }).fill("1");
  const pdfPage = usesActualManual ? 79 : 1;
  await editor
    .getByLabel("PDF page number", { exact: true })
    .fill(String(pdfPage));
  await editor
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  const reference = page.getByRole("link", {
    name: new RegExp(`Cessna 441 Maintenance Manual.*PDF page ${pdfPage}`),
  });
  await expect(reference).toHaveAttribute(
    "href",
    new RegExp(`page=${pdfPage}`),
  );
  const href = await reference.getAttribute("href");
  await reference.click();
  const viewer = page.getByRole("dialog", {
    name: "Manual reference",
    exact: true,
  });
  await expect(
    viewer.getByRole("heading", { name: "Cessna 441 Maintenance Manual" }),
  ).toBeVisible();
  await expect(viewer.locator("canvas[role=img]")).toHaveAttribute(
    "aria-label",
    new RegExp(`PDF page ${pdfPage}$`),
  );
  await page.goto(href!);
  await expect(page.locator("canvas[role=img]")).toHaveAttribute(
    "aria-label",
    new RegExp(`PDF page ${pdfPage}$`),
  );
  await page.reload();
  await expect(page.locator("canvas[role=img]")).toHaveAttribute(
    "aria-label",
    new RegExp(`PDF page ${pdfPage}$`),
  );
});
