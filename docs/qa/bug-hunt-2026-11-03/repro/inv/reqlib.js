const { go } = require("./lib");
// Create a request from an inventory stock row.
async function requestFromStock(page, partNumber, qty, opts = {}) {
  await go(page, "/inventory");
  const row = page.getByRole("row").filter({ hasText: partNumber });
  await row.getByRole("button", { name: /Parts \/ repair requests/ }).click();
  const ws = page.getByRole("dialog", { name: "Parts / repair requests" });
  await ws.getByRole("button", { name: "New request" }).click();
  const editor = page.getByRole("dialog", { name: "New parts / repair request" });
  await editor.getByLabel("Quantity", { exact: true }).fill(String(qty));
  if (opts.priority) await editor.getByLabel("Priority").selectOption(opts.priority);
  await editor.getByRole("button", { name: "Save request" }).click();
  await editor.waitFor({ state: "detached" });
  await ws.getByRole("button", { name: "Close dialog" }).click();
}
async function requestsToPO(page, numbers, vendor) {
  await go(page, "/parts-requests");
  await page.getByRole("heading", { name: "Parts & repair requests" }).waitFor();
  for (const n of numbers) await page.getByLabel(`Select ${n}`).check();
  await page.getByRole("button", { name: /Add selected to purchase order/ }).click();
  const d = page.getByRole("dialog", { name: "Purchase requested parts / repair services" });
  await d.getByLabel("Vendor", { exact: true }).fill(vendor);
  await d.getByRole("button", { name: "Save draft PO" }).click();
  await d.waitFor({ state: "detached" });
}
async function openRequest(page, number) {
  await go(page, "/parts-requests");
  await page.getByRole("button", { name: number, exact: true }).click();
  return page.getByRole("dialog", { name: new RegExp("^" + number) });
}
async function requestAction(page, detail, op, stockUuid, qty) {
  await detail.getByLabel("Inventory action").selectOption(op);
  await detail.getByLabel("Stock lot / location").selectOption(stockUuid);
  await detail.getByLabel("Quantity", { exact: true }).fill(String(qty));
  const label = op === "reserve" ? "Reserve stock" : op === "release" ? "Release reservation" : "Issue reserved parts";
  await detail.getByRole("button", { name: label }).click();
}
module.exports = { requestFromStock, requestsToPO, openRequest, requestAction };
