// Issuing stock through a parts request lowers the stock quantity, but the stock
// item's Record history (the "audited stock ledger") has no entry for it.
const { start, go, seed, loc, stock, result } = require("./lib");
const { requestFromStock, openRequest, requestAction } = require("./reqlib");
(async () => {
  const { browser, page } = await start();
  try {
    await seed(page, [{ ...loc("L1", "Main hangar"), address: "1 Hangar Rd" }, stock("S1", "L1", "FILTER-1", { description: "Oil filter", quantity: 5 })]);
    // A normal stock movement is recorded in the item's history.
    await go(page, "/inventory");
    let row = page.getByRole("row").filter({ hasText: "FILTER-1" });
    await row.getByRole("button", { name: "Move stock" }).click();
    const move = page.getByRole("dialog", { name: "Stock movement" });
    await move.getByLabel("Movement type").selectOption("receive");
    await move.getByLabel("Quantity (counted balance for adjustment)").fill("1");
    await move.getByRole("button", { name: "Save" }).click();
    await move.waitFor({ state: "detached" });
    // Issue 2 through a parts request.
    await requestFromStock(page, "FILTER-1", 2);
    const rd = await openRequest(page, "PR-00001");
    await requestAction(page, rd, "reserve", "S1", 2);
    await rd.getByText("Reserved 2 · Issued 0").waitFor();
    await requestAction(page, rd, "issue", "S1", 2);
    await rd.getByText("Reserved 0 · Issued 2").waitFor();
    await go(page, "/inventory");
    row = page.getByRole("row").filter({ hasText: "FILTER-1" });
    const qty = /QTY (\d+)/.exec((await row.innerText()).replace(/\s+/g, " "))[1];
    await row.getByRole("button", { name: "Details" }).click();
    const d = page.getByRole("dialog", { name: "Stock item" });
    const events = d.locator(".management-event");
    await events.first().waitFor();
    await page.waitForTimeout(500);
    const actions = await events.locator("strong").allInnerTexts();
    const last = JSON.parse(await events.first().locator("pre").textContent());
    console.log("Inventory quantity:", qty, "| history:", actions.join(", "), "| latest recorded quantity:", last.quantity);
    await d.getByRole("heading", { name: "Record history" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "bug-stock-history-missing-issue.png" });
    result(Number(qty) === 4 && last.quantity === 6 && actions.length === 1,
      `FILTER-1 shows quantity ${qty} but its Record history ends at quantity ${last.quantity} (entries: ${actions.join(", ")}); the parts-request issue of 2 is missing`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });
