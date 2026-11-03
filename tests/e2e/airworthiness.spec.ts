import { test, expect } from "@playwright/test";
import path from "node:path";
import { existsSync } from "node:fs";
// A real customer AD report; kept out of git, so the import test runs only
// where a local copy exists.
const adReport = path.resolve("tests/fixtures/CompReport_N626KB.docx");
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/airworthiness");
  await expect(
    page.getByRole("heading", {
      name: "Airworthiness directives",
      exact: true,
    }),
  ).toBeVisible();
});
test("previews the original Word report without inventing component assignments", async ({
  page,
}) => {
  test.skip(!existsSync(adReport), "Local customer AD report not present.");
  await page.getByLabel("Import AD Word report").setInputFiles(adReport);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("51 AD entries");
  await expect(dialog).toContainText("N626KB");
  await expect(dialog).toContainText("circular supersession");
  await expect(
    dialog.getByRole("button", { name: "Confirm import" }),
  ).toBeDisabled();
  for (const checkbox of await dialog
    .getByLabel("Skip this section for now")
    .all())
    await checkbox.check();
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: /^View AD /, includeHidden: true }),
  ).toHaveCount(29);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^View AD /, includeHidden: true }),
  ).toHaveCount(29);
  const group = page.locator(".ad-register-group").first();
  await expect(group.locator("summary")).toContainText("29 ADs");
  await page.screenshot({
    path: "/tmp/ad-register-desktop.png",
    fullPage: true,
  });
  await expect(group.getByRole("table")).not.toBeVisible();
  await group.locator("summary").click();
  await expect(group.getByRole("table")).toBeVisible();
  await group.locator("summary").click();
  await expect(group.getByRole("table")).not.toBeVisible();
});
test("records recurring compliance, persists it, exports a PDF, and flags due work", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("AD number", { exact: true }).fill("2026-01-01");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Inspect attachment fittings");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Applicable");
  await dialog.getByLabel("Applicability and source changes reviewed").check();
  await dialog.getByRole("button", { name: "Add required action" }).click();
  await dialog
    .getByLabel("Required action", { exact: true })
    .fill("Inspect fittings per paragraph (g)");
  await dialog.getByLabel("Action recurrence").selectOption("Recurring");
  await dialog.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await dialog.getByLabel("Next due hours").fill("2300");
  await dialog.getByLabel("Repeat every hours").fill("100");
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator(".ad-register-group > summary").first().click();
  await expect(page.getByText("Overdue", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details for AD 2026-01-01" }).click();
  await page
    .getByRole("button", { name: "Record compliance", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Hours at completion").fill("2340");
  await dialog
    .getByLabel("Method of compliance")
    .fill("Inspected fittings; no defects");
  await dialog.getByRole("button", { name: "Save compliance" }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.locator(".ad-register-group > summary").first().click();
  await page.getByRole("button", { name: "Details for AD 2026-01-01" }).click();
  await expect(page.getByText(/2440 hours/)).toBeVisible();
  await page.getByText("Compliance history (1)", { exact: false }).click();
  await expect(page.getByText(/Inspected fittings; no defects/)).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save compliance PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^AD-Compliance-N206MA.*\.pdf$/);
  await download.saveAs(test.info().outputPath(download.suggestedFilename()));
  await page.getByRole("button", { name: "Review / edit AD" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await dialog.getByLabel("Next due hours").fill("2000");
  // Changing an applicable AD with compliance recorded needs a reason.
  await dialog
    .getByLabel("Reason for change")
    .fill("Due hours corrected from paragraph (g).");
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("link", { name: /AD 2026-01-01/ })).toBeVisible();
});
test("flags a one-time limit left after compliance, clears it with a reason, and corrects compliance", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("AD number", { exact: true }).fill("2026-04-04");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Inspect wing attach fittings");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Applicable");
  await dialog.getByLabel("Applicability and source changes reviewed").check();
  await dialog.getByRole("button", { name: "Add required action" }).click();
  await dialog
    .getByLabel("Required action", { exact: true })
    .fill("Inspect fittings per paragraph (g)");
  await dialog.getByLabel("Action recurrence").selectOption("Recurring");
  await dialog.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await dialog.getByLabel("Next due hours").fill("2300");
  await dialog.getByLabel("Repeat every hours").fill("100");
  // A new AD is not a correction.
  await expect(dialog.getByLabel("Reason for change")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator(".ad-register-group > summary").first().click();
  await page.getByRole("button", { name: "Details for AD 2026-04-04" }).click();
  await page
    .getByRole("button", { name: "Record compliance", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Hours at completion").fill("2340");
  await dialog
    .getByLabel("Method of compliance")
    .fill("Inspected fittings; no defects");
  await dialog.getByRole("button", { name: "Save compliance" }).click();
  await expect(dialog).not.toBeVisible();
  // A one-time date on the repeating action after compliance, as compliance
  // recorded before the #42 fix left behind.
  await page.getByRole("button", { name: "Review / edit AD" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Calendar", exact: true }).check();
  await dialog.getByLabel("Next due date").fill("2025-06-01");
  await expect(dialog.getByLabel("Reason for change")).toHaveAttribute(
    "required",
    "",
  );
  await dialog
    .getByLabel("Reason for change")
    .fill("Initial calendar limit from paragraph (f).");
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "2026-04-04" });
  await expect(row).toContainText("Overdue");
  await expect(row).toContainText(
    "This one-time limit (due date 2025-06-01) was not cleared when compliance was recorded on",
  );
  await expect(
    page.getByText(/1 AD has a one-time limit that was not cleared/),
  ).toBeVisible();
  await row.getByRole("button", { name: /^Clear initial limit/ }).click();
  dialog = page.getByRole("dialog", { name: "Clear initial limit" });
  await expect(dialog.getByLabel("Reason for change")).toHaveValue(
    /due date 2025-06-01.*satisfied by the compliance recorded on/,
  );
  await dialog
    .getByRole("button", { name: "Clear initial limit", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toContainText("Scheduled");
  await expect(row).not.toContainText("This one-time limit");
  // The demo user administers the Flight Program, so it can correct the entry.
  await page.getByRole("button", { name: "Details for AD 2026-04-04" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("Compliance history (1)", { exact: false }).click();
  await dialog.getByRole("button", { name: /^Correct entry of / }).click();
  dialog = page.getByRole("dialog", { name: "Correct AD compliance record" });
  await expect(dialog.getByLabel("Hours at completion")).toHaveValue("2340");
  await dialog.getByLabel("Hours at completion").fill("2330");
  await dialog
    .getByLabel("Reason for correction")
    .fill("Hours copied from the wrong logbook page.");
  await dialog.getByRole("button", { name: "Save correction" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Details for AD 2026-04-04" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/2430 hours/)).toBeVisible();
  await dialog.getByText("Compliance history (1)", { exact: false }).click();
  await expect(
    dialog.getByText(/Originally recorded: .* 2340 hours/),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByRole("link", { name: "Change history", exact: true }).click();
  await expect(
    page.getByText("Hours copied from the wrong logbook page.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/One-time initial limit \(due date 2025-06-01\)/),
  ).toBeVisible();
});
test("shows renewal settings but never accepts API keys in offline demo storage", async ({
  page,
}) => {
  await page
    .getByText("FAA connection and renewal settings", { exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "FAA API key and renewal" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Update FAA API key" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Request / renew key at FAA" }),
  ).toHaveAttribute("href", "https://drs.faa.gov/drs-api");
});
test("prefills FAA search from aircraft profiles, supports overrides and resets without changing profiles", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Search FAA ADs & Import" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("N206MA model", { exact: true })).toHaveValue(
    "206 Stationair",
  );
  await expect(
    dialog.getByLabel("N206MA manufacturer", { exact: true }),
  ).toHaveValue("Cessna");
  await expect(
    dialog.getByLabel("Filter by manufacturer for N206MA"),
  ).not.toBeChecked();
  await expect(
    dialog.getByLabel("Final-rule ADs", { exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByLabel("Emergency ADs", { exact: true }),
  ).toBeChecked();
  await dialog.getByLabel("N206MA model", { exact: true }).fill("U206");
  await dialog.getByRole("button", { name: "Reset from profiles" }).click();
  await expect(dialog.getByLabel("N206MA model", { exact: true })).toHaveValue(
    "206 Stationair",
  );
  await expect(
    dialog.getByRole("button", { name: "Search FAA", exact: true }),
  ).toBeDisabled();
});

test("marking an AD not applicable completes review and persists the status", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("AD number", { exact: true }).fill("2026-02-02");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Applicability review test");
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator(".ad-register-group > summary").first().click();
  await page.getByRole("button", { name: "Review / edit AD" }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Not applicable");
  await dialog
    .getByLabel("Applicability reason / paragraph")
    .fill("Aircraft serial number outside paragraph (c) range.");
  await expect(
    dialog.getByLabel("Applicability and source changes reviewed"),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.locator(".ad-register-group > summary").first().click();
  await expect(page.getByText("Not applicable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review / edit AD" }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Applicability and source changes reviewed"),
  ).toBeChecked();
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Needs review");
  await expect(
    dialog.getByLabel("Applicability and source changes reviewed"),
  ).not.toBeChecked();
});

test("records previous compliance with aircraft total time and date", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("AD number", { exact: true }).fill("2026-03-03");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Previously completed inspection");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Previously Complied With (PCW)");
  await dialog.getByLabel("Recurring", { exact: true }).selectOption("No");
  await dialog.getByLabel("Previous compliance date").fill("2025-01-01");
  await dialog
    .getByLabel("Aircraft total time at compliance (hours)")
    .fill("1234.5");
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.locator(".ad-register-group > summary").first().click();
  await expect(
    page.getByText("Previously Complied With (PCW)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Details for AD 2026-03-03" }).click();
  await expect(
    page.getByText(/2025-01-01 · Aircraft total time: 1234.5 hours/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Review / edit AD" }).click();
  await expect(dialog.getByLabel("Previous compliance date")).toHaveValue(
    "2025-01-01",
  );
  await expect(
    dialog.getByLabel("Aircraft total time at compliance (hours)"),
  ).toHaveValue("1234.5");
});

test("saves a superseded AD and its replacement reference", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("AD number", { exact: true }).fill("2025-04-04");
  await dialog
    .getByLabel("Subject", { exact: true })
    .fill("Replaced inspection");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Superseded");
  await expect(
    dialog.getByLabel("Superseded by (source reference)"),
  ).toHaveAttribute("required", "");
  await dialog
    .getByLabel("Superseded by (source reference)")
    .fill("2026-03-01");
  await expect(
    dialog.getByLabel("Applicability and source changes reviewed"),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.locator(".ad-register-group > summary").first().click();
  await expect(page.getByText("Superseded", { exact: true })).toBeVisible();
  await expect(page.getByText(/Superseded by: 2026-03-01/)).toBeVisible();
});
