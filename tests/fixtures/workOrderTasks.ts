/**
 * Responsibility: Opens a work order's tasks, and the single open movement
 *   order.
 * Layer: Test. Playwright helpers against the demo.
 * Dependencies: @playwright/test.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Work-order tasks render as collapsed <details>; opens task `n` (1-based)
 * unless it is already open.
 * @param dialog - The work order's dialog.
 */
export async function expandTask(dialog: Locator, n: number) {
  const task = dialog.locator("details.work-order-task-details").nth(n - 1);
  if ((await task.getAttribute("open")) === null)
    await task.locator("> summary").click();
  await expect(task).toHaveAttribute("open", "");
}

/**
 * Opens the single open work order, a component movement, checks that Task 1
 * names `part`, and expands it. The list no longer shows the scope, so the
 * task is what identifies the order.
 * @param page - A demo page with exactly one open order.
 * @param part - Text Task 1's summary must contain.
 * @returns The order's dialog, with Task 1 expanded.
 */
export async function openMovementOrder(page: Page, part: string) {
  await page.goto("/work-orders");
  const row = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Details", exact: true }),
  });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Details", exact: true }).click();
  const order = page.getByRole("dialog");
  await expect(
    order.locator("summary.work-order-task-summary").first(),
  ).toContainText(part);
  await expandTask(order, 1);
  return order;
}
