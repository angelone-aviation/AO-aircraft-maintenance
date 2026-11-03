const { go } = require("./lib");
async function openWorkOrder(page, number = "WO-COST-1") {
  await go(page, "/work-orders");
  await page.getByRole("heading", { name: "Work orders", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open work order", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Work order number").fill(number);
  await dialog.getByLabel("Assigned supervisor").fill("Test supervisor");
  await dialog.getByLabel("Additional requested work").fill("Inspect cabin fittings");
  await dialog.getByRole("button", { name: "Add requested work", exact: true }).click();
  await dialog.getByRole("button", { name: "Open work order", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const row = page.getByRole("row").filter({ hasText: number });
  await row.getByRole("button", { name: "Details", exact: true }).click();
  return page.getByRole("dialog").first();
}
module.exports = { openWorkOrder };
