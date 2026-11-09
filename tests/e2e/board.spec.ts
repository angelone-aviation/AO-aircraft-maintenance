/**
 * Responsibility: Pins the board view in the demo: the board preview shows
 *   the read-only fleet summary for every route and nothing else, downloads
 *   the PDF board summary, and the administrator can open /board.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, pdfjs-dist (legacy Node build), node:fs.
 */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

test("board preview shows the read-only fleet summary and nothing else", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview board view" }).click();
  await expect(
    page.getByRole("heading", { name: "Fleet summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Board view", exact: true }),
  ).toBeVisible();
  for (const name of ["Overview", "Flight log", "Administration", "Settings"])
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  await expect(
    page.locator(".ds-kpi-label", { hasText: "Airworthy" }),
  ).toBeVisible();
  await expect(
    page.locator(".ds-kpi-label", { hasText: "Overdue items" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Due in the next 30 days" }),
  ).toBeVisible();
  await expect(
    page.getByText("Off-site backups run only on the production deployment."),
  ).toBeVisible();
  // The aircraft list shows status and spend totals, never descriptions.
  await expect(page.getByText("N208MA", { exact: true })).toBeVisible();
  await expect(page.getByText("1 open discrepancy")).toBeVisible();
  await expect(page.getByText("Left landing light")).toHaveCount(0);

  // Every route is the board view for a board member.
  await page.goto("/flights");
  await expect(
    page.getByRole("heading", { name: "Fleet summary" }),
  ).toBeVisible();

  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download board summary (PDF)" })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^board-summary-\d{4}-\d{2}-\d{2}\.pdf$/,
  );
  const file = (await download.path())!;
  const doc = await getDocument({
    data: new Uint8Array(await readFile(file)),
    useSystemFonts: true,
  }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
  for (const phrase of [
    "Board summary",
    "Fleet status",
    "Due in the next 30 days",
    "Off-site backup",
    "N206MA",
  ])
    expect(text).toContain(phrase);
  expect(text).not.toContain("Left landing light");

  // The preview survives a reload; leaving it returns to the current route.
  await page.goto("/");
  await page.getByRole("button", { name: "Exit board preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();

  // Administrators open the same view from the navigation and keep theirs.
  await page.getByRole("link", { name: "Board view", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Fleet summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Exit board preview" }),
  ).toHaveCount(0);
});
