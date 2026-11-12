/**
 * Responsibility: Pins the shop screens' charts: the work orders status bar,
 *   and the Costs page's month bars and category ring, each with its
 *   accessible name and the amounts it stands for.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const ORDER_NUMBER = "WO-CHARTS";
const PHONE = { width: 390, height: 844 };

test("charts work orders by status, and costs by month and by category", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await expect(
    page.getByRole("figure", { name: "Work orders by status" }),
  ).toHaveCount(0);
  await openOrderWithCosts(page);

  const byStatus = page.getByRole("figure", { name: "Work orders by status" });
  await expect(byStatus.getByRole("listitem")).toHaveText(["Open1100%"]);

  await page.goto("/costs");
  const byMonth = page.getByRole("figure", { name: "Costs by month" });
  const month = new Date().toLocaleString("en-US", { month: "short" });
  // The figure's text alternative: a table of the same amounts.
  await expect(
    byMonth.getByRole("row").filter({ hasText: month }).getByRole("cell"),
  ).toHaveText(["$120", "$0", "$45.50"]);
  await expect(byMonth.getByRole("row")).toHaveCount(13);
  await expect(byMonth.locator(".recharts-surface")).toBeVisible();

  const byCategory = page.getByRole("figure", { name: "Costs by category" });
  await expect(byCategory.getByRole("listitem")).toHaveText([
    "Labor$12072.5%",
    "Parts$00%",
    "Other$45.5027.5%",
  ]);
  await expect(byCategory.locator(".recharts-surface")).toBeVisible();

  // Phones keep the ring, whose legend holds the amounts, and drop the bars.
  await page.setViewportSize(PHONE);
  await expect(byMonth).toBeHidden();
  await expect(byCategory).toBeVisible();
  await page.goto("/work-orders");
  await expect(byStatus).toBeHidden();
});

/** Opens a work order and records $120 of labor and a $45.50 fee, today. */
async function openOrderWithCosts(page: Page) {
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Work order number").fill(ORDER_NUMBER);
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: ORDER_NUMBER })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  const costs = dialog.getByRole("region", { name: "Costs", exact: true });
  const labor = costForm(costs, "Add labor");
  await labor.getByLabel("Hours", { exact: true }).fill("1.5");
  await labor.getByLabel("Rate per hour (USD)", { exact: true }).fill("80");
  await labor.getByRole("button", { name: "Add labor", exact: true }).click();
  await expect(labor.getByLabel("Hours", { exact: true })).toHaveValue("");
  const other = costForm(costs, "Add cost");
  await other.getByLabel("Amount (USD)", { exact: true }).fill("45.50");
  await other.getByLabel("Description", { exact: true }).fill("Hangar fee");
  await other.getByRole("button", { name: "Add cost", exact: true }).click();
  await expect(other.getByLabel("Description", { exact: true })).toHaveValue(
    "",
  );
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

// Labor and other costs each have a Date field, so fields are found per form.
function costForm(costs: Locator, submitLabel: string): Locator {
  return costs.locator("form").filter({
    has: costs.page().getByRole("button", { name: submitLabel, exact: true }),
  });
}
