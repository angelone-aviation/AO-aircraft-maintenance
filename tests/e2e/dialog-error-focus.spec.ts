/**
 * Responsibility: Pins what a user sees after a refused save in a dialog form
 *   that shows its own error rather than using AsyncForm: the error is in
 *   view inside the dialog and focus stays on the Save button.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * The AD and AD compliance forms disable their Save button while saving,
 * which dropped focus to <body>, and their error sat at the end of a long
 * form, below the visible part of the dialog.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 664 },
  { name: "desktop", width: 1440, height: 900 },
];
const DUPLICATE_AD = "This AD already exists for the selected asset.";
const OVER_TOTALS =
  "Completion hours and cycles cannot exceed the current totals.";

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("a refused AD save shows its error and keeps focus on Save AD", async ({
      page,
    }) => {
      await openAirworthiness(page);
      await saveAD(await fillAD(page, "2026-05-05"));
      const dialog = await fillAD(page, "2026-05-05");
      const save = dialog.getByRole("button", { name: "Save AD", exact: true });
      await save.click();
      await expectRevealed(dialog, DUPLICATE_AD);
      await expect(save).toBeFocused();
    });

    test("a refused compliance record shows its error and keeps focus on Save compliance", async ({
      page,
    }) => {
      await openAirworthiness(page);
      await saveAD(await fillAD(page, "2026-06-06"));
      await page.locator(".ad-register-group > summary").first().click();
      await page
        .getByRole("button", { name: "Details for AD 2026-06-06" })
        .click();
      await page
        .getByRole("button", { name: "Record compliance", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Hours at completion").fill("99999");
      await dialog.getByLabel("Method of compliance").fill("Inspected");
      const save = dialog.getByRole("button", { name: "Save compliance" });
      await save.click();
      await expectRevealed(dialog, OVER_TOTALS);
      await expect(save).toBeFocused();
    });
  });
}

async function openAirworthiness(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/airworthiness");
  await expect(
    page.getByRole("heading", { name: "Airworthiness directives" }),
  ).toBeVisible();
}

/** Opens a new applicable AD with one recurring action every 100 hours. */
async function fillAD(page: Page, number: string): Promise<Locator> {
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("AD number", { exact: true }).fill(number);
  await dialog.getByLabel("Subject", { exact: true }).fill("Wing fittings");
  await dialog
    .getByLabel("Applicability", { exact: true })
    .selectOption("Applicable");
  await dialog.getByLabel("Applicability and source changes reviewed").check();
  await dialog.getByRole("button", { name: "Add required action" }).click();
  await dialog
    .getByLabel("Required action", { exact: true })
    .fill("Inspect fittings");
  await dialog.getByLabel("Action recurrence").selectOption("Recurring");
  await dialog.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await dialog.getByLabel("Next due hours").fill("2300");
  await dialog.getByLabel("Repeat every hours").fill("100");
  return dialog;
}

async function saveAD(dialog: Locator) {
  await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Waits for the alert, then checks it lies inside the visible part of the
 * dialog's scrolling body and that the point at its centre is the alert.
 */
async function expectRevealed(dialog: Locator, message: string) {
  const alert = dialog.getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible();
  await expect
    .poll(() => alert.evaluate(isUncovered), { timeout: 3000 })
    .toBe(true);
}

function isUncovered(alert: Element): boolean {
  const body = alert.closest(".ds-dialog-body");
  if (!body) return false;
  const a = alert.getBoundingClientRect();
  const view = body.getBoundingClientRect();
  // Scrolled flush with the edge, the alert can overhang it by a subpixel.
  const bottom = Math.min(view.bottom, innerHeight) + 1;
  if (a.top < view.top || a.bottom > bottom) return false;
  const hit = document.elementFromPoint(a.left + 20, a.top + a.height / 2);
  return hit !== null && alert.contains(hit);
}
