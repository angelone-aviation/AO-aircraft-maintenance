// Labor entered as 1.33 h at $100.00/h is charged $133.33 (stored as 80 minutes).
const fs = require("fs");
const { start, go, result } = require("./lib");
const { openWorkOrder } = require("./wolib");
(async () => {
  const { browser, page } = await start();
  try {
    const d = await openWorkOrder(page, "WO-COST-1");
    const costs = d.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Costs", exact: true }) });
    await costs.getByLabel("Hours").fill("1.33");
    await costs.getByLabel("Rate per hour (USD)").fill("100");
    await costs.getByRole("button", { name: "Add labor" }).click();
    const row = costs.getByRole("row").filter({ hasText: "Alex Morgan" });
    await row.waitFor();
    const cells = (await row.getByRole("cell").allInnerTexts()).map((t) => t.trim());
    console.log("Labor row:", cells.slice(0, 5).join(" | "));
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "bug-labor-rounding.png" });
    const amount = cells[4];
    // Cost report CSV
    await go(page, "/costs");
    await page.getByRole("heading", { name: "Costs", exact: true }).waitFor();
    const statLabor = (await page.locator(".shop-cost-stats").innerText()).replace(/\s+/g, " ");
    console.log("Costs page:", statLabor);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
    const csvPath = __dirname + "/bug-labor-rounding.csv";
    await dl.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, "utf8");
    console.log("CSV:\n" + csv);
    result(amount !== "$133.00", `1.33 h × $100.00/h is recorded as ${amount} (expected $133.00); CSV labor hours: ${/"WO-COST-1","[^"]*","[^"]*","([^"]*)"/.exec(csv)?.[1]}`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });
