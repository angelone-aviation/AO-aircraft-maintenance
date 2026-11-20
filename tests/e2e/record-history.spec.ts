/**
 * Responsibility: Pins the Record history panel of the inspection dialogs in
 *   the demo: a record with no change-log entries yet shows an empty state,
 *   not an error, and no Load older button.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";

for (const button of ["Complete", "Details"])
  test(`an inspection's ${button} dialog shows an empty history as empty`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await page.goto("/inspections");
    await page
      .getByRole("button", { name: button, exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    const history = dialog.locator("section", {
      has: page.getByRole("heading", { name: "Record history" }),
    });
    await expect(history.getByText("No recorded changes.")).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
    await expect(history.getByText("History not found.")).toHaveCount(0);
    await expect(
      history.getByRole("button", { name: "Load older" }),
    ).toHaveCount(0);
  });
