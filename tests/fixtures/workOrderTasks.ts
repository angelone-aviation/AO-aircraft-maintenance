import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Work-order tasks render as collapsed <details>; open task `n` (1-based). */
export async function expandTask(dialog: Locator, n: number) {
  const task = dialog.locator("details.work-order-task-details").nth(n - 1);
  if ((await task.getAttribute("open")) === null)
    await task.locator("> summary").click();
  await expect(task).toHaveAttribute("open", "");
}

/**
 * The work-order list no longer shows the scope, so a movement order is the
 * single open order; confirm Task 1 names the expected part, then open it.
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
