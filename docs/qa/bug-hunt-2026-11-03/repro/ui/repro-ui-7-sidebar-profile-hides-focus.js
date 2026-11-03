// ui-7: tabbing down the desktop sidebar scrolls each next link to the
// bottom edge of the sidebar scroller, underneath the sticky profile footer
// (Alex Morgan / My certifications / Settings), so the focused link is hidden.
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const hidden = [];
  try {
    await page.goto(BASE + "/");
    await page.getByRole("button", { name: /Explore the local demo/ }).click();
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
    await page.locator(".sidebar .brand").focus();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const r = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a.closest(".sidebar")) return { out: true };
        if (a.closest(".profile")) return {};
        const rect = a.getBoundingClientRect();
        let hits = 0;
        for (let fx = 0.05; fx < 1; fx += 0.15)
          for (let fy = 0.05; fy < 1; fy += 0.15) {
            const e = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
            if (e && (e === a || a.contains(e))) hits++;
          }
        const c = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { label: (a.getAttribute("aria-label") || a.textContent).trim().slice(0, 30), hits, coveredByProfile: !!c?.closest(".profile") };
      });
      if (r.out) break;
      if (r.hits === 0 && r.coveredByProfile) {
        if (!hidden.length) await page.screenshot({ path: __dirname + "/shots/ui-7-hidden-sidebar-focus.png", clip: { x: 0, y: 500, width: 400, height: 300 } });
        hidden.push(r.label);
      }
    }
  } finally {
    await browser.close();
  }
  console.log("focused sidebar entries fully hidden under the profile footer:", JSON.stringify(hidden));
  if (hidden.length) {
    console.log(`REPRODUCED: ${hidden.length} sidebar links are completely hidden under the sticky profile footer when reached with Tab at 1280x800 (first: "${hidden[0]}")`);
    process.exitCode = 1;
  } else {
    console.log("NOT REPRODUCED");
    process.exitCode = 0;
  }
})().catch((e) => { console.error(e); process.exit(2); });
