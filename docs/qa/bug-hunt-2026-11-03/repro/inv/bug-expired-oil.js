// Flight-line oil usage issues stock that is past its shelf life, although every
// other issue path refuses expired stock ("Expired stock cannot be issued or reserved").
const { start, go, seed, loc, stock, snapshot, result } = require("./lib");
(async () => {
  const { browser, page } = await start();
  try {
    const today = await page.evaluate(() => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); });
    const expired = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);
    await seed(page, [loc("L1", "Flight line"), stock("OIL1", "L1", "OIL-15W50", { description: "Engine oil quart", quantity: 5, oil: true, expirationDate: expired })]);
    // Inventory screen shows the lot as expired.
    await go(page, "/inventory");
    const row = page.getByRole("row").filter({ hasText: "OIL-15W50" });
    await row.getByText("Expired", { exact: true }).waitFor();
    // Admin "Move stock -> Issue stock" refuses it.
    await row.getByRole("button", { name: "Move stock" }).click();
    const move = page.getByRole("dialog", { name: "Stock movement" });
    await move.getByLabel("Movement type").selectOption("issue");
    await move.getByLabel("Quantity (counted balance for adjustment)").fill("1");
    await move.getByRole("button", { name: "Save" }).click();
    const moveErr = (await move.getByRole("alert").innerText()).trim();
    console.log("Move stock -> Issue:", moveErr);
    await move.getByRole("button", { name: "Close dialog" }).click();
    // Flight-line usage of the same lot.
    await go(page, "/");
    await page.getByRole("button", { name: "Log a flight", exact: true }).click();
    const d = page.getByRole("dialog").last();
    await d.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
    // Two hours ago in local time, so the flight is never in the future.
    const flownAt = await page.evaluate(() => {
      const t = new Date(Date.now() - 2 * 3600000);
      const p = (n) => String(n).padStart(2, "0");
      return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
    });
    await d.getByLabel("Flight date & time").fill(flownAt);
    await d.getByLabel("Engine oil starting level (US qt)").fill("6");
    await d.getByLabel("Engine oil quantity added (US qt)").fill("1");
    await d.getByLabel("Use inventory for engine oil", { exact: true }).check();
    await d.getByLabel("Engine oil inventory location", { exact: true }).selectOption("L1");
    const partSelect = d.getByLabel("Engine oil inventory part number", { exact: true });
    const option = (await partSelect.locator("option").allInnerTexts()).join(" / ");
    console.log("Oil part options:", option);
    // Once fixed, the picker lists the expired lot as disabled. Enable it anyway
    // (as a stale form would) so the save path's own refusal is exercised too.
    if (!(await partSelect.locator('option[value="OIL1"]:not([disabled])').count())) {
      console.log("Picker does not offer the expired lot; forcing it to test the save path.");
      await partSelect.locator('option[value="OIL1"]').evaluate((o) => o.removeAttribute("disabled"));
    }
    await partSelect.selectOption("OIL1");
    await d.getByLabel("Engine oil stock units used", { exact: true }).fill("1");
    await d.getByRole("button", { name: "Save flight", exact: true }).click();
    await d.waitFor({ state: "detached" });
    // Wait until the demo backend has processed the flight (it syncs asynchronously).
    let s;
    for (let i = 0; i < 40; i++) {
      s = (await snapshot(page))[0];
      if (s.flights.length) break;
      await page.waitForTimeout(250);
    }
    const oil = s.management.find((r) => r.uuid === "OIL1");
    const audit = s.audit.find((a) => a.action === "stock.oil_used");
    console.log("Stock after flight:", oil.quantity, "audit:", audit && audit.action);
    await go(page, "/inventory");
    const after = page.getByRole("row").filter({ hasText: "OIL-15W50" });
    await after.getByText("Expired", { exact: true }).waitFor();
    await page.waitForTimeout(800);
    await after.screenshot({ path: "bug-expired-oil.png" });
    result(/expired/i.test(moveErr) && oil.quantity === 4,
      `oil lot expired on ${expired} was drawn down from 5 to ${oil.quantity} by a logged flight, while Issue stock refuses it ("${moveErr}")`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });
