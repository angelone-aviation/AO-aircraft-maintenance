const { go, seed, loc, stock } = require("./lib");
async function setupPO(page, { lines, shipping = "0", expected = "", vendor = "Acme Parts", extraRecords = [] }) {
  await go(page, "/purchase-orders");
  await page.getByRole("heading", { name: "Purchase orders", exact: true }).waitFor();
  const L1 = { ...loc("L1","Main hangar"), address: "1 Hangar Rd, Town" };
  await seed(page, [L1, { ...loc("L2","Remote"), address: "2 Remote Rd" }, stock("S1","L1","FILTER-1",{quantity: 2, cost: 19.99}),
    { kind: "vendor", uuid: "V1", programUuid: "demo-program", version: 1, name: vendor, website: "", accountNumber: "", paymentTerms: "", notes: "" }, ...extraRecords]);
  await page.getByRole("heading", { name: "Purchase orders", exact: true }).waitFor();
  await page.getByRole("button", { name: "New PO" }).click();
  const d = page.getByRole("dialog").last();
  await d.getByLabel("Vendor", { exact: true }).fill(vendor);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1, l = lines[i];
    if (i > 0) await d.getByRole("button", { name: "Add part" }).click();
    await d.getByLabel(`Part ${n} inventory location`).selectOption(l.location || "L1");
    if (l.stock) await d.getByLabel(`Part ${n} stock item`).selectOption(l.stock);
    else {
      await d.getByLabel(`Part ${n} number`).fill(l.pn);
      await d.getByLabel(`Part ${n} description`).fill(l.desc || l.pn + " desc");
      if (l.kind) await d.getByLabel(`Part ${n} category`).selectOption(l.kind);
    }
    await d.getByLabel(`Part ${n} quantity`, { exact: true }).fill(String(l.qty));
    if (l.unit !== undefined) await d.getByLabel(`Part ${n} unit cost`).fill(String(l.unit));
    if (l.exchange) { await d.getByLabel(`Part ${n} is an exchange (core return due)`).check(); if (l.coreDays) await d.getByLabel(`Part ${n} core due (days after receipt)`).fill(String(l.coreDays)); }
  }
  await d.getByLabel("Shipping cost").fill(shipping);
  if (expected) await d.getByLabel("Expected delivery").fill(expected);
  const dd = page.getByRole("dialog", { name: /New purchase order/ });
  await d.getByRole("button", { name: "Save draft PO" }).click();
  await dd.waitFor({ state: "detached" });
}
async function openPO(page, number = "PO-00001") {
  await page.getByRole("button", { name: number, exact: true }).click();
  return page.getByRole("dialog").first();
}
async function issue(page, detail) {
  await detail.getByRole("button", { name: "Issue PO", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Finalize PO", exact: true }).click();
  await detail.getByRole("heading").first().filter({ hasText: "Issued" }).waitFor();
}
async function receive(page, detail, qtys, opts = {}) {
  await detail.getByRole("button", { name: /^Receive/ }).click();
  const dialog = page.getByRole("dialog", { name: /^Receive parts ·/ });
  if (opts.date) await dialog.getByLabel("Receipt date").fill(opts.date);
  if (opts.invoice) await dialog.getByLabel("Invoice number").fill(opts.invoice);
  for (const [pn, q] of Object.entries(qtys)) await dialog.getByLabel(`${pn} quantity received`).fill(String(q));
  if (opts.before) await opts.before(dialog);
  await dialog.getByRole("button", { name: "Confirm receipt into inventory", exact: true }).click();
  const err = dialog.getByRole("alert");
  await Promise.race([dialog.waitFor({ state: "detached" }), err.waitFor()]);
  if (await err.count()) return await err.innerText();
  return null;
}
module.exports = { setupPO, openPO, issue, receive };
