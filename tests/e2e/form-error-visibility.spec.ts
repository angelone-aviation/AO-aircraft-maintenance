/**
 * Responsibility: Pins what a user sees after a dialog form's save is
 *   refused: the error is on screen, not under the sticky Save footer, and
 *   keyboard focus stays on the Save button instead of falling to the page.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * Finding UI-13: the refusal rendered below the visible part of a long form,
 * under the stuck footer, and focus dropped to <body> when the busy Save
 * button was disabled, so the user saw nothing and a screen reader lost its
 * place.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 664 },
  { name: "desktop", width: 1440, height: 900 },
  // Under 500px tall the dialog scrolls as one and its footer is not sticky.
  { name: "landscape phone", width: 844, height: 390 },
];
const DUPLICATE_REGISTRATION = "Registration already exists.";
const CHOOSE_AIRCRAFT =
  "Choose the aircraft this group can access, or choose all aircraft in this program.";

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("a refused Add aircraft shows its error above the footer and keeps focus on the button", async ({
      page,
    }) => {
      await openDemo(page, "/aircraft");
      await page
        .getByRole("button", { name: "Add aircraft", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await fillAircraft(dialog, page);
      const save = dialog.getByRole("button", {
        name: "Add aircraft",
        exact: true,
      });
      await save.click();
      await expectRevealed(dialog, DUPLICATE_REGISTRATION);
      await expect(save).toBeFocused();
    });

    test("a refused new permission group shows its error above the footer and keeps focus on the button", async ({
      page,
    }) => {
      await openDemo(page, "/admin");
      await page
        .getByRole("group", { name: "Administration sections" })
        .getByRole("button", { name: "Permission groups", exact: true })
        .click();
      await page.getByRole("button", { name: "Add group", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Group name").fill("Line pilots");
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await save.click();
      await expectRevealed(dialog, CHOOSE_AIRCRAFT);
      await expect(save).toBeFocused();
    });
  });
}

test("Enter in a field of a refused form returns focus to that field", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS[0]);
  await openDemo(page, "/aircraft");
  await page.getByRole("button", { name: "Add aircraft", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await fillAircraft(dialog, page);
  const landings = dialog.getByLabel("Current landings");
  await landings.press("Enter");
  await expectRevealed(dialog, DUPLICATE_REGISTRATION);
  await expect(landings).toBeFocused();
});

async function openDemo(page: Page, path: string) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
}

async function fillAircraft(dialog: Locator, page: Page) {
  await dialog.getByLabel("Registration", { exact: true }).fill("N206MA");
  await dialog.getByLabel(/^Make/).first().fill("Cessna");
  await page.keyboard.press("Tab");
  await dialog.getByLabel(/^Model/).first().fill("172");
  await page.keyboard.press("Tab");
  await dialog.getByLabel("Current Hobbs (hours)").fill("100");
  await dialog.getByLabel("Current tach (hours)").fill("100");
  await dialog.getByLabel("Current landings").fill("5");
}

/**
 * Waits for the alert, then checks it lies inside the dialog's scrolling body
 * and that the point at its centre is the alert itself, not the stuck footer.
 */
async function expectRevealed(dialog: Locator, message: string) {
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(message);
  await expect
    .poll(() => alert.evaluate(isUncovered), { timeout: 3000 })
    .toBe(true);
}

function isUncovered(alert: Element): boolean {
  const body = alert.closest(".ds-dialog-body");
  if (!body) return false;
  const a = alert.getBoundingClientRect();
  const view = body.getBoundingClientRect();
  if (a.top < view.top || a.bottom > Math.min(view.bottom, innerHeight))
    return false;
  const hit = document.elementFromPoint(a.left + 20, a.top + a.height / 2);
  return hit !== null && alert.contains(hit);
}
