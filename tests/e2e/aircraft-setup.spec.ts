/**
 * Responsibility: Pins the Set up an aircraft wizard: creating an aircraft,
 *   loading the inspection and AD templates, the dry run, the commit, the
 *   records it leaves on their screens, the resumable draft and the Fleet
 *   page's setup chips.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures/aircraft-setup-*.csv.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const inspectionsCsv = path.resolve(
  "tests/fixtures/aircraft-setup-inspections.csv",
);
const adsCsv = path.resolve("tests/fixtures/aircraft-setup-ads.csv");

test("sets up an aircraft from the two templates after a dry run, then resumes and chips the fleet", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/aircraft");
  await page
    .getByRole("link", { name: "Set up an aircraft", exact: true })
    .click();
  await expect(page).toHaveURL(/\/aircraft\/setup$/);
  // Steps after the first wait for the aircraft to exist.
  await expect(
    page.getByRole("button", { name: /Components installed/ }),
  ).toBeDisabled();
  await page.getByLabel("Registration", { exact: true }).fill("N410SU");
  await page.getByLabel("Make", { exact: true }).fill("Cessna");
  await page.getByLabel("Model", { exact: true }).fill("206 Stationair");
  await page.getByLabel("Current Hobbs (hours)", { exact: true }).fill("1200");
  await page.getByLabel("Current tach (hours)", { exact: true }).fill("1100");
  await page.getByLabel("Current landings", { exact: true }).fill("800");
  await page.getByRole("button", { name: "Add aircraft", exact: true }).click();
  await expect(page).toHaveURL(/\/aircraft\/setup\/[^/?]+\?step=components$/);
  await expect(
    page.getByRole("heading", { name: "Components installed", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No installed components recorded yet."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Next: Inspections" }).click();
  await page.getByLabel("Inspections CSV file").setInputFiles(inspectionsCsv);
  const inspectionRows = page.getByRole("table", { name: "Inspections rows" });
  await expect(inspectionRows.getByRole("row")).toHaveCount(3);
  await expect(inspectionRows).toContainText("12 mo");
  await expect(inspectionRows).toContainText("1,180.0 h");

  await page.getByRole("button", { name: "Next: AD compliance" }).click();
  await page.getByLabel("AD compliance CSV file").setInputFiles(adsCsv);
  const adRows = page.getByRole("table", { name: "AD compliance rows" });
  await expect(adRows.getByRole("row")).toHaveCount(3);
  await expect(adRows).toContainText("Recurring");

  await page.getByRole("button", { name: "Next: Review (dry run)" }).click();
  await expect(
    page.getByText(/Nothing from the Inspections and AD compliance steps/),
  ).toBeVisible();
  const toSave = page.getByRole("table", { name: "Records to save" });
  await expect(toSave.getByRole("row")).toHaveCount(5);
  await expect(toSave).toContainText("Every 12 months · last done 2026-03-15");
  await expect(toSave).toContainText(
    "PCW 2026-09-30 at 1180 h · next due 1280 h · recurring",
  );
  await expect(toSave).toContainText("Not applicable");
  await expect(page.getByText("Fix before saving")).toHaveCount(0);
  // Nothing is saved by the dry run.
  await page.goto("/inspections");
  await expect(
    page.getByText("Annual inspection", { exact: true }),
  ).toHaveCount(0);
  await page.goBack();

  await page.getByRole("button", { name: "Next: Save" }).click();
  await page
    .getByRole("button", { name: "Save 2 inspections and 2 ADs", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Setup saved for N410SU",
  );
  const progress = page.getByRole("list", { name: "Save progress" });
  await expect(progress.getByText("Saved", { exact: true })).toHaveCount(4);

  // The draft remembers what was saved, so a resumed review skips it all.
  await page.reload();
  await page.getByRole("button", { name: /Review \(dry run\)/ }).click();
  await expect(page.getByText("Skipped rows (4)")).toBeVisible();
  await expect(page.getByText("Nothing to save.")).toBeVisible();

  await page.goto("/inspections");
  const mine = page
    .getByRole("table", { name: "Inspections", exact: true })
    .getByRole("row")
    .filter({ hasText: "N410SU" });
  await expect(mine).toHaveCount(2);
  await expect(mine.filter({ hasText: "Annual inspection" })).toHaveCount(1);
  await expect(mine.filter({ hasText: "100-hour inspection" })).toHaveCount(1);
  await page.goto("/airworthiness");
  await page
    .getByLabel("Aircraft", { exact: true })
    .selectOption({ label: "N410SU · 206 Stationair" });
  for (const number of ["2011-10-09", "2004-21-05"])
    await expect(
      page.getByRole("button", {
        name: `Details for AD ${number}`,
        includeHidden: true,
      }),
    ).toHaveCount(1);

  // The new aircraft still has no components, and its chip opens that step.
  await page.goto("/aircraft");
  const row = page
    .getByRole("list", { name: "Aircraft", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "N410SU" });
  await expect(
    row.getByRole("link", { name: "Inspections missing" }),
  ).toHaveCount(0);
  await expect(row.getByRole("link", { name: "ADs not reviewed" })).toHaveCount(
    0,
  );
  await row.getByRole("link", { name: "Components missing" }).click();
  await expect(page).toHaveURL(/step=components$/);
  await expect(
    page.getByRole("heading", { name: "Components installed", exact: true }),
  ).toBeVisible();
});
