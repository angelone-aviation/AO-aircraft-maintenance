// ui-1: Escape in a nested dialog also closes the parent dialog, discarding
// its unsaved form (New purchase order -> Add new address -> Escape).
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const openDialogs = () =>
    page.locator("dialog[open]").evaluateAll((ds) => ds.map((d) => d.getAttribute("aria-label") || d.querySelector("h2")?.textContent));
  try {
    await page.goto(BASE + "/");
    await page.getByRole("button", { name: /Explore the local demo/ }).click();
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
    await page.goto(BASE + "/purchase-orders");
    await page.getByRole("button", { name: "New PO" }).click();
    const po = page.getByRole("dialog", { name: "New purchase order" });
    await po.waitFor();
    await po.getByLabel("Vendor", { exact: true }).fill("Acme Aviation Supply");
    await po.getByLabel("Part 1 number").fill("PN-12345");
    await po.getByRole("button", { name: "Add new address" }).click();
    await page.getByRole("dialog", { name: "Add new shipping address" }).waitFor();
    console.log("open before Escape:", JSON.stringify(await openDialogs()));
    // Escape is meant to cancel the top-most dialog only (same as its Close button).
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Add new shipping address" }).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    const after = await openDialogs();
    console.log("open after Escape:", JSON.stringify(after));
    await page.screenshot({ path: __dirname + "/shots/ui-1-after-escape.png" });
    const poOpen = after.includes("New purchase order");
    const vendor = poOpen ? await po.getByLabel("Vendor", { exact: true }).inputValue() : "(dialog gone)";
    // Same pattern on a phone: More sheet -> My certifications -> Escape.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + "/");
    await page.getByRole("button", { name: "More", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "All sections" });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "My certifications" }).click();
    await page.getByRole("dialog", { name: "My certifications" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "My certifications" }).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    const phoneAfter = await openDialogs();
    console.log("phone: open after Escape in My certifications (opened from All sections):", JSON.stringify(phoneAfter));
    if (!poOpen || vendor !== "Acme Aviation Supply") {
      console.log(`REPRODUCED: Escape in nested "Add new shipping address" also closed "New purchase order" (vendor field: ${vendor})${phoneAfter.includes("All sections") ? "" : "; same for My certifications -> All sections sheet"}`);
      process.exitCode = 1;
    } else {
      console.log("NOT REPRODUCED");
      process.exitCode = 0;
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(2); });
