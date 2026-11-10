/**
 * Responsibility: Pins how number and money fields read a comma: a decimal
 *   comma is refused with a plain message instead of being read as a number
 *   10 to 1,000 times larger, in a meter field and a money field alike.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const COMMA_MESSAGE =
  "Use a point for decimals, as in 2342.5, and leave out thousands commas.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
});

test("a decimal comma typed in Ending Hobbs is refused, not read as 23425", async ({
  page,
}) => {
  const hobbs = await openFlightForm(page);
  await hobbs.pressSequentially("2342,5");
  await expect(hobbs).toHaveAttribute("aria-invalid", "true");
  expect(
    await hobbs.evaluate((i: HTMLInputElement) => i.validationMessage),
  ).toBe(COMMA_MESSAGE);
  // The digits after the refused comma do not slip through on save.
  await page.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await hobbs.fill("");
  await hobbs.pressSequentially("2342.5");
  await expect(hobbs).not.toHaveAttribute("aria-invalid");
  expect(await hobbs.evaluate((i: HTMLInputElement) => i.validity.valid)).toBe(
    true,
  );
});

test("a pasted comma or exponent is refused in a number field", async ({
  page,
}) => {
  const hobbs = await openFlightForm(page);
  await hobbs.focus();
  await page.keyboard.insertText("2342,5");
  await expect(hobbs).toHaveValue("");
  await expect(hobbs).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.insertText("1e5");
  expect(
    await hobbs.evaluate((i: HTMLInputElement) => i.validationMessage),
  ).toBe("Type the number in plain digits, as in 2342.5.");
  // A grouped number keeps its value: the decimal point clears the mark.
  await hobbs.pressSequentially("2,342.5");
  await expect(hobbs).toHaveValue("2342.5");
  await expect(hobbs).not.toHaveAttribute("aria-invalid");
});

test("a money field refuses 45,50 instead of saving $4,550.00", async ({
  page,
}) => {
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Default labor rate" });
  const rate = section.getByLabel("Rate per hour (USD)");
  const save = section.getByRole("button", { name: "Save rate", exact: true });
  await rate.fill("45,50");
  await save.click();
  await expect(section.getByRole("alert")).toHaveText(COMMA_MESSAGE);
  await rate.fill("1,045.50");
  await save.click();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section).toContainText("$1,045.50");
});

async function openFlightForm(page: Page) {
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  return page.getByLabel("Ending Hobbs *", { exact: true });
}
