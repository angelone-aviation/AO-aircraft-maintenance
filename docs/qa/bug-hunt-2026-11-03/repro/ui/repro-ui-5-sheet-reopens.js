// ui-5: the "All sections" sheet is hidden (not closed) when the window
// crosses into the desktop breakpoint, so it pops open again by itself when
// the window returns to tablet width (e.g. rotating an iPad Pro 1024x1366).
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1024, height: 1366 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const sheetOpen = () => page.locator("dialog[open]").filter({ has: page.getByRole("heading", { name: "All sections" }) }).count();
  try {
    await page.goto(BASE + "/");
    await page.getByRole("button", { name: /Explore the local demo/ }).click();
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "All sections", exact: true }).click();
    await page.getByRole("dialog", { name: "All sections" }).waitFor();
    console.log("portrait 1024x1366, sheet open:", await sheetOpen());
    await page.setViewportSize({ width: 1366, height: 1024 }); // rotate -> desktop sidebar
    await page.waitForTimeout(400);
    console.log("landscape 1366x1024, sheet open:", await sheetOpen());
    await page.getByRole("complementary").getByRole("link", { name: "Vendors" }).click();
    await page.getByRole("heading", { name: "Vendors", level: 1 }).waitFor();
    await page.setViewportSize({ width: 1024, height: 1366 }); // rotate back
    await page.waitForTimeout(400);
    const reopened = await sheetOpen();
    console.log("portrait again on /vendors, sheet open:", reopened);
    await page.screenshot({ path: __dirname + "/shots/ui-5-sheet-reopened.png" });
    if (reopened) {
      console.log("REPRODUCED: All sections sheet re-opened by itself after rotating desktop -> tablet (it was never closed)");
      process.exitCode = 1;
    } else {
      console.log("NOT REPRODUCED");
      process.exitCode = 0;
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(2); });
