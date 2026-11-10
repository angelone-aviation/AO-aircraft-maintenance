/**
 * Responsibility: Pins that a filled-in form in a dialog is not discarded
 *   without asking: Escape and the browser's Back ask first, an empty form
 *   closes at once, and keyboard focus stays in the form when the user keeps
 *   it.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const QUESTION = "Discard what you have entered in this form?";
const REMARKS = "Night leg, crosswind landing";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
});

test("Escape asks before discarding a filled-in flight form", async ({
  page,
}) => {
  const remarks = await openFilledFlightForm(page);
  const asked = answerNext(page, false);
  await page.keyboard.press("Escape");
  expect(await asked).toBe(QUESTION);
  await expect(remarks).toHaveValue(REMARKS);
  await expect(remarks).toBeFocused();

  const again = answerNext(page, true);
  await page.keyboard.press("Escape");
  expect(await again).toBe(QUESTION);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Log a flight", exact: true }),
  ).toBeFocused();
});

test("Back asks before discarding a filled-in flight form", async ({
  page,
}) => {
  // Give Back somewhere to go: the Flight log, then the overview again.
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(page).toHaveURL(/\/flights/);
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  const remarks = await openFilledFlightForm(page);
  const asked = answerNext(page, false);
  await page.evaluate(() => history.back());
  expect(await asked).toBe(QUESTION);
  await expect(page).not.toHaveURL(/\/flights/);
  await expect(remarks).toHaveValue(REMARKS);
});

test("an untouched form closes on Escape without asking", async ({ page }) => {
  let asked = false;
  page.on("dialog", (question) => {
    asked = true;
    void question.dismiss();
  });
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(asked).toBe(false);
});

async function openFilledFlightForm(page: Page) {
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  const remarks = page.getByRole("dialog").getByLabel("Remarks");
  await remarks.fill(REMARKS);
  return remarks;
}

// Answers the next browser question (yes or no) and gives back its text.
function answerNext(page: Page, accept: boolean) {
  return new Promise<string>((resolve) => {
    page.once("dialog", (question) => {
      resolve(question.message());
      void (accept ? question.accept() : question.dismiss());
    });
  });
}
