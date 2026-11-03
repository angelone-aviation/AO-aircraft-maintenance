// ui-6: the keyboard focus ring on sidebar links is clipped by the
// collapsible group wrapper (overflow: hidden): the left/right sides are cut
// off on every link, the top is cut off on the first link of a group and the
// bottom on the last. In the light theme the remaining ring (#1830f8 on the
// #0b1434 sidebar) is 2.4:1, below the 3:1 WCAG 1.4.11 minimum.
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  const findings = [];
  try {
    await page.goto(BASE + "/");
    await page.getByRole("button", { name: /Explore the local demo/ }).click();
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
    const probe = await browser.newPage(); // decodes screenshots
    for (const href of ["/", "/flights", "/discrepancies"]) {
      const link = page.locator(`.sidebar nav a[href='${href}']`);
      // Reach it with the keyboard so :focus-visible applies.
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const a = document.activeElement;
        const cs = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        const off = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth) / 2; // centre line of the ring
        return { label: a.textContent.trim(), fv: a.matches(":focus-visible"), color: cs.outlineColor, side: getComputedStyle(a.closest("aside")).backgroundColor,
          pts: { left: [r.left - off, r.top + r.height / 2], right: [r.right + off, r.top + r.height / 2], top: [r.left + r.width / 2, r.top - off], bottom: [r.left + r.width / 2, r.bottom + off] } };
      });
      const png = (await page.screenshot()).toString("base64");
      const seen = await probe.evaluate(async ({ png, pts }) => {
        const img = new Image(); img.src = "data:image/png;base64," + png; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0);
        const out = {};
        for (const [k, [px, py]] of Object.entries(pts)) { const d = x.getImageData(Math.round(px), Math.round(py), 1, 1).data; out[k] = [d[0], d[1], d[2]].join(","); }
        return out;
      }, { png, pts: info.pts });
      const ring = info.color.match(/\d+/g).slice(0, 3).join(",");
      const missing = Object.entries(seen).filter(([, c]) => c !== ring).map(([k]) => k);
      console.log(`${info.label}: focus-visible=${info.fv} ring=${ring} pixels=${JSON.stringify(seen)} missing sides=[${missing}]`);
      if (missing.length) findings.push(`${info.label}: ${missing.join("/")} side(s) not drawn`);
      if (href === "/") {
        const lum = (c) => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const [hi, lo] = [lum(info.color), lum(info.side)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        console.log(`ring ${info.color} vs sidebar ${info.side}: contrast ${ratio.toFixed(2)}:1`);
        if (ratio < 3) findings.push(`ring contrast ${ratio.toFixed(2)}:1 (< 3:1)`);
        await page.screenshot({ path: __dirname + "/shots/ui-6-overview-focus.png", clip: { x: 0, y: (await link.boundingBox()).y - 12, width: 264, height: 66 } });
      }
    }
  } finally {
    await browser.close();
  }
  if (findings.length) {
    console.log("REPRODUCED: sidebar focus ring clipped/low-contrast in light theme — " + findings.join("; "));
    process.exitCode = 1;
  } else {
    console.log("NOT REPRODUCED");
    process.exitCode = 0;
  }
})().catch((e) => { console.error(e); process.exit(2); });
