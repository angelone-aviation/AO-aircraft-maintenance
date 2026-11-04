/**
 * Responsibility: Pins a work order's costs panel for a program administrator:
 *   labor and other costs added and removed, the amounts each line shows, and
 *   the totals they drive, kept across a reload.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const ORDER_NUMBER = "WO-COSTS";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

test("adds and removes labor and other costs and keeps the totals in step", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await openNewOrder(page);
  let costs = await openCosts(page);
  await expectTotals(costs, ["$0.00", "$0.00", "$0.00", "$0.00"]);
  await addLabor(costs, "1.5", "80");
  await expect(
    costs.getByRole("heading", { name: "Labor · 1.5 h", exact: true }),
  ).toBeVisible();
  await expect(
    costs.getByRole("row").filter({ hasText: "Alex Morgan" }).getByRole("cell"),
  ).toHaveText([ISO_DATE, "Alex Morgan", "1.5", "$80.00/h", "$120.00", ""]);
  await expectTotals(costs, ["$120.00", "$0.00", "$0.00", "$120.00"]);
  await addOtherCost(costs, "45.50", "Hangar fee");
  await expect(
    costs.getByRole("row").filter({ hasText: "Hangar fee" }).getByRole("cell"),
  ).toHaveText([ISO_DATE, "Hangar fee", "$45.50", ""]);
  await expectTotals(costs, ["$120.00", "$0.00", "$45.50", "$165.50"]);
  await page.reload();
  costs = await openCosts(page);
  await expectTotals(costs, ["$120.00", "$0.00", "$45.50", "$165.50"]);
  await costs
    .getByRole("button", { name: /^Remove labor for Alex Morgan on / })
    .click();
  await expect(costs.getByText("No labor recorded.")).toBeVisible();
  await expectTotals(costs, ["$0.00", "$0.00", "$45.50", "$45.50"]);
  await costs.getByRole("button", { name: "Remove Hangar fee" }).click();
  await expect(costs.getByText("No other costs recorded.")).toBeVisible();
  await expectTotals(costs, ["$0.00", "$0.00", "$0.00", "$0.00"]);
});

async function openNewOrder(page: Page) {
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Work order number").fill(ORDER_NUMBER);
  await dialog
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

/** Opens the order's details and returns its costs panel. */
async function openCosts(page: Page): Promise<Locator> {
  await page
    .getByRole("row")
    .filter({ hasText: ORDER_NUMBER })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  return page
    .getByRole("dialog")
    .getByRole("region", { name: "Costs", exact: true });
}

/** Records labor for the signed-in technician, dated today. */
async function addLabor(costs: Locator, hours: string, rate: string) {
  const form = costForm(costs, "Add labor");
  await form.getByLabel("Hours", { exact: true }).fill(hours);
  await form.getByLabel("Rate per hour (USD)", { exact: true }).fill(rate);
  await form.getByRole("button", { name: "Add labor", exact: true }).click();
  await expect(form.getByLabel("Hours", { exact: true })).toHaveValue("");
}

async function addOtherCost(costs: Locator, amount: string, text: string) {
  const form = costForm(costs, "Add cost");
  await form.getByLabel("Amount (USD)", { exact: true }).fill(amount);
  await form.getByLabel("Description", { exact: true }).fill(text);
  await form.getByRole("button", { name: "Add cost", exact: true }).click();
  await expect(form.getByLabel("Description", { exact: true })).toHaveValue("");
}

// Labor and other costs each have a Date field, so fields are found per form.
function costForm(costs: Locator, submitLabel: string): Locator {
  return costs.locator("form").filter({
    has: costs.page().getByRole("button", { name: submitLabel, exact: true }),
  });
}

/** Expects the labor, parts, other and grand totals, in that order. */
async function expectTotals(costs: Locator, amounts: string[]) {
  await expect(costs.getByRole("definition")).toHaveText(amounts);
}
