// Expired stock is counted as "Available" in a parts request, hiding the shortage,
// although the same stock cannot be reserved or issued.
const { start, go, seed, loc, stock, result } = require("./lib");
(async () => {
  const { browser, page } = await start();
  try {
    await go(page, "/inventory");
    await page.getByRole("heading", { name: "Inventory", exact: true }).waitFor();
    const today = await page.evaluate(() => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); });
    const yesterday = new Date(Date.parse(today) - 2 * 86400000).toISOString().slice(0, 10);
    await seed(page, [loc("L1", "Main hangar"), stock("S1", "L1", "SEAL-EXP", { description: "O-ring seal", quantity: 5, expirationDate: yesterday })]);
    const row = page.getByRole("row").filter({ hasText: "SEAL-EXP" });
    await row.getByText("Expired", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Parts / repair requests" }).click();
    const ws = page.getByRole("dialog", { name: "Parts / repair requests" });
    await ws.getByRole("button", { name: "New request" }).click();
    const editor = page.getByRole("dialog", { name: "New parts / repair request" });
    await editor.getByLabel("Quantity", { exact: true }).fill("3");
    await editor.getByRole("button", { name: "Save request" }).click();
    await editor.waitFor({ state: "detached" });
    await ws.getByRole("button", { name: "PR-00001" }).click();
    const detail = page.getByRole("dialog", { name: /^PR-00001/ });
    const availability = (await detail.locator(".request-availability strong").innerText()).trim();
    console.log("Request shows:", availability);
    // Try to reserve the "available" stock.
    await detail.getByLabel("Stock lot / location").selectOption("S1");
    await detail.getByLabel("Quantity", { exact: true }).fill("3");
    await detail.getByRole("button", { name: "Reserve stock" }).click();
    const err = detail.getByRole("alert");
    await err.waitFor();
    const message = await err.innerText();
    console.log("Reserve result:", message);
    await page.screenshot({ path: "bug-expired-available.png", fullPage: false });
    const shownAvailable = Number(/Available: (\d+)/.exec(availability)[1]);
    const shownShortage = Number(/Shortage: (\d+)/.exec(availability)[1]);
    result(shownAvailable > 0 && shownShortage === 0 && /expired/i.test(message),
      `request shows "${availability}" for stock expired on ${yesterday}, but reserving it fails: "${message.trim()}"`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });
