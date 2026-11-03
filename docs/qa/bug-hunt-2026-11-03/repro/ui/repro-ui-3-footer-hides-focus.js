// ui-3: in dialog forms, Tab (or a phone keyboard's "next field" arrow)
// scrolls the next field to the bottom edge of the dialog body, underneath
// the sticky Save/Cancel footer, so the focused, editable field is hidden.
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
const cases = [
  { w: 320, h: 640, route: "/", open: (p) => p.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Log flight" }).click() },
  { w: 390, h: 844, route: "/inspections", open: (p) => p.getByRole("button", { name: "New inspection" }).click() },
  { w: 1280, h: 800, route: "/purchase-orders", open: (p) => p.getByRole("button", { name: "New PO" }).click() },
];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const found = [];
  try {
    for (const c of cases) {
      const phone = c.w < 760;
      const context = await browser.newContext({ viewport: { width: c.w, height: c.h }, isMobile: phone, hasTouch: phone, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(BASE + "/");
      await page.getByRole("button", { name: /Explore the local demo/ }).click();
      await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
      if (c.route !== "/") await page.goto(BASE + c.route);
      await c.open(page);
      const dialog = page.locator("dialog[open]");
      await dialog.waitFor();
      const title = await dialog.evaluate((d) => d.querySelector("h2")?.textContent);
      await page.waitForTimeout(300);
      let shot = false;
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press("Tab");
        const r = await page.evaluate(() => {
          const a = document.activeElement;
          if (!a || !a.closest("dialog")) return { out: true };
          const editable = (a.tagName === "INPUT" && !a.readOnly && !["checkbox", "radio", "button", "submit"].includes(a.type)) || a.tagName === "SELECT" || a.tagName === "TEXTAREA";
          const rect = a.getBoundingClientRect();
          if (!editable || !rect.width || !rect.height) return {};
          let hits = 0;
          for (let fx = 0.05; fx < 1; fx += 0.225)
            for (let fy = 0.05; fy < 1; fy += 0.225) {
              const e = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
              if (e && (e === a || a.contains(e))) hits++;
            }
          const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          const footer = top && top.closest(".form-footer");
          return { hidden: hits === 0 && !!footer, label: (a.labels?.[0]?.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 50), footer: footer ? footer.textContent.trim().replace(/\s+/g, " ").slice(0, 30) : null };
        });
        if (r.out) break;
        if (r.hidden) {
          found.push(`${c.w}x${c.h} "${title}": "${r.label}" under footer [${r.footer}]`);
          if (!shot) { await page.screenshot({ path: `${__dirname}/shots/ui-3-${c.w}x${c.h}.png` }); shot = true; }
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  found.forEach((f) => console.log("hidden focused field:", f));
  if (found.length) {
    console.log(`REPRODUCED: ${found.length} focused editable dialog field(s) fully hidden behind the sticky form footer, e.g. ${found[0]}`);
    process.exitCode = 1;
  } else {
    console.log("NOT REPRODUCED");
    process.exitCode = 0;
  }
})().catch((e) => { console.error(e); process.exit(2); });
