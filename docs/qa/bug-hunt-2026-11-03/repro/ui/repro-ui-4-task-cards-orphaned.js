// ui-4: the /task-cards screen (h1 "Job cards"; docs: "Standalone cards can
// also be created from Task cards -> New task card") has no entry in the
// sidebar, the tablet rail + "All sections" sheet, or the phone tab bar +
// More sheet, and no link to it exists on any screen reachable from them.
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const result = {};
  try {
    for (const [w, h, label] of [[1280, 800, "desktop sidebar"], [900, 1100, "tablet rail + All sections"], [390, 844, "phone tab bar + More"]]) {
      const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(BASE + "/");
      await page.getByRole("button", { name: /Explore the local demo/ }).click();
      await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
      // Navigation entries (sidebar, rail, tab bar, and the All sections sheet when present).
      const sheetBtn = page.getByRole("button", { name: w < 760 ? "More" : "All sections", exact: true });
      if (await sheetBtn.count()) {
        await sheetBtn.click();
        await page.getByRole("dialog", { name: "All sections" }).waitFor();
      }
      const navHrefs = await page.locator("aside a[href], nav a[href], dialog[open] a[href]").evaluateAll((as) => [...new Set(as.map((a) => new URL(a.href).pathname))]);
      if (await sheetBtn.count()) await page.keyboard.press("Escape");
      // Every screen reachable from those entries: collect in-page links too.
      const inPage = new Set();
      for (const path of navHrefs) {
        await page.goto(BASE + path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(250);
        (await page.locator("main a[href]").evaluateAll((as) => as.map((a) => new URL(a.href, location.href).pathname))).forEach((p) => inPage.add(p));
      }
      result[label] = { nav: navHrefs.includes("/task-cards"), inPage: inPage.has("/task-cards"), navCount: navHrefs.length };
      await context.close();
    }
    // Sanity: the route itself exists and renders.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(BASE + "/");
    await page.getByRole("button", { name: /Explore the local demo/ }).click();
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
    await page.goto(BASE + "/task-cards");
    const h1 = await page.locator("main h1").first().textContent();
    const newCard = await page.getByRole("button", { name: /New (task|job) card/ }).count();
    await page.screenshot({ path: __dirname + "/shots/ui-4-task-cards.png" });
    console.log("route /task-cards renders h1:", JSON.stringify(h1), "new-card buttons:", newCard);
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(result));
  const unreachable = Object.values(result).every((r) => !r.nav && !r.inPage);
  if (unreachable) {
    console.log("REPRODUCED: /task-cards (Job cards) has no sidebar, rail, tab bar or More-sheet entry and no in-app link from any navigable screen");
    process.exitCode = 1;
  } else {
    console.log("NOT REPRODUCED");
    process.exitCode = 0;
  }
})().catch((e) => { console.error(e); process.exit(2); });
