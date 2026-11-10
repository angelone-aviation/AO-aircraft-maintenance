/**
 * Responsibility: Pins the Set up an aircraft wizard: creating an aircraft,
 *   loading the inspection and AD templates, the dry run, the commit, the
 *   records it leaves on their screens, the resumable draft, the Fleet
 *   page's setup chips, the one commit per aircraft and the confirmation of
 *   an unusual AD number.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures/aircraft-setup-*.csv.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const inspectionsCsv = path.resolve(
  "tests/fixtures/aircraft-setup-inspections.csv",
);
const adsCsv = path.resolve("tests/fixtures/aircraft-setup-ads.csv");
const INSPECTION_HEADER =
  "name,interval_hours,interval_months,interval_cycles,interval_landings,last_done_date,last_done_hours,last_done_cycles,last_done_landings,manual_reference";
const AD_HEADER =
  "ad_number,title,applies,compliance_date,compliance_hours,method,next_due_hours,next_due_date,recurring,notes";
const BULK_ROWS = 150;

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

  // The draft remembers what was saved, so a resumed review skips it all and
  // says why for every row.
  await page.reload();
  await page.getByRole("button", { name: /Review \(dry run\)/ }).click();
  await expect(
    page.getByText(
      "Save will write nothing. 4 rows will not be saved; each is listed below with the reason.",
    ),
  ).toBeVisible();
  const notSaved = page.getByRole("table", { name: "Rows not saved" });
  await expect(notSaved.getByRole("row")).toHaveCount(5);
  await expect(
    notSaved.getByText(/This setup saved it earlier, so it is not saved again/),
  ).toHaveCount(4);

  // A second file on the same spreadsheet rows is new work, not "saved".
  await page.getByRole("button", { name: /^3\s*Inspections/ }).click();
  await page
    .getByLabel("Inspections rows (CSV)")
    .fill(
      `${INSPECTION_HEADER}\nELT battery,,12,,,2026-01-10,,,,91.207\nPitot-static,,24,,,2025-06-01,,,,91.411`,
    );
  await page.getByRole("button", { name: /Review \(dry run\)/ }).click();
  await expect(
    page.getByText(/^Save will write 2 inspections and 0 ADs\./),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Records to save" }),
  ).toContainText("ELT battery");

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

test("keeps one commit per aircraft when the Save step is left and reopened", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/aircraft/setup/demo-206?step=inspections");
  const rows = Array.from(
    { length: BULK_ROWS },
    (_, i) => `Bulk item ${i + 1},100,,,,,2300.5,,,ref`,
  );
  const text = page.getByLabel("Inspections rows (CSV)");
  await text.fill([INSPECTION_HEADER, ...rows].join("\n"));
  const step = (name: RegExp) =>
    page
      .getByRole("list", { name: "Setup steps" })
      .getByRole("button", { name });
  await step(/Save$/).click();
  await page
    .getByRole("button", { name: `Save ${BULK_ROWS} inspections and 0 ADs` })
    .click();
  const progress = page.getByRole("list", { name: "Save progress" });
  await expect(
    progress.getByText("Saved", { exact: true }).first(),
  ).toBeVisible();

  // Leaving the step does not stop the commit, and the other steps say so.
  await step(/Inspections/).click();
  await expect(
    page.getByText(/^Saving the setup: \d+ of 150 rows done/),
  ).toBeVisible();
  await expect(text).not.toBeEditable();

  // Back on Save there is the running commit, never a second Save button.
  await step(/Save$/).click();
  await expect(progress).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Save \d+ inspections/ }),
  ).toHaveCount(0);
  await expect(page.getByText("Setup saved for N206MA")).toBeVisible({
    timeout: 60_000,
  });
  await expect(progress.getByText("Saved", { exact: true })).toHaveCount(
    BULK_ROWS,
  );
  await step(/Review \(dry run\)/).click();
  await expect(
    page.getByText(
      `Save will write nothing. ${BULK_ROWS} rows will not be saved; each is listed below with the reason.`,
    ),
  ).toBeVisible();
  // Every row is on the aircraft exactly once, in each stored snapshot.
  const counts = await page.evaluate(savedBulkCounts);
  expect(counts.length).toBeGreaterThan(0);
  for (const names of counts) {
    expect(names.total).toBe(BULK_ROWS);
    expect(names.distinct).toBe(BULK_ROWS);
  }
});

// Counts the "Bulk item" inspections in every snapshot the demo keeps in
// IndexedDB; runs in the page.
async function savedBulkCounts() {
  const snapshots = await new Promise<
    { inspections?: { description: string }[] }[]
  >((resolve, reject) => {
    const request = indexedDB.open("angel-one-v1");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const all = request.result
        .transaction("snapshots", "readonly")
        .objectStore("snapshots")
        .getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => reject(all.error);
    };
  });
  return snapshots.map((s) => {
    const names = (s.inspections ?? [])
      .map((i) => i.description)
      .filter((d) => d.startsWith("Bulk item"));
    return { total: names.length, distinct: new Set(names).size };
  });
}

test("holds the commit until an AD number a spreadsheet rewrote is confirmed", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/aircraft/setup/demo-206?step=ads");
  await page
    .getByLabel("AD compliance rows (CSV)")
    .fill(`${AD_HEADER}\n10/9/2011,Seat rail,no,,,,,,,`);
  await page.getByRole("button", { name: "Next: Review (dry run)" }).click();
  await expect(page.getByText("Confirm before saving")).toBeVisible();
  await expect(
    page.getByText(
      /Row 2 \(AD 10\/9\/2011\): the AD number is not in the form/,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next: Save" }).click();
  const save = page.getByRole("button", {
    name: "Save 0 inspections and 1 AD",
  });
  await expect(save).toBeDisabled();
  await page
    .getByLabel(/I have checked these AD numbers against the directives/)
    .check();
  await expect(save).toBeEnabled();
});
