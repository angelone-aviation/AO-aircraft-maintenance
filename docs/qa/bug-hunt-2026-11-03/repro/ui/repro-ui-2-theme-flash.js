// ui-2: with the dark theme saved, every load/reload first renders frames in
// the light palette (#f3f4f8 background) until the app's JS module runs
// initTheme(). Measured with the service worker controlling the page.
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Record the html background of every rendered frame (rAF runs once per
  // frame, right before paint) until the .dark class is applied.
  await context.addInitScript(() => {
    window.__frames = [];
    const tick = () => {
      const html = document.documentElement;
      if (html && document.styleSheets.length) {
        window.__frames.push({ t: Math.round(performance.now()), dark: html.classList.contains("dark"), bg: getComputedStyle(html).backgroundColor });
        if (html.classList.contains("dark")) return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const page = await context.newPage();
  try {
    await page.goto(BASE + "/");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    console.log("saved theme:", await page.evaluate(() => localStorage.getItem("angelone-theme")));
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    // Reload again so the page is served by the service worker (warm cache).
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const frames = [];
    cdp.on("Page.screencastFrame", async (f) => { frames.push(f.data); await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
    await cdp.send("Page.startScreencast", { format: "png", maxWidth: 640, maxHeight: 400 });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.waitForTimeout(500);
    await cdp.send("Page.stopScreencast");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const sw = await page.evaluate(() => !!navigator.serviceWorker.controller);
    const log = await page.evaluate(() => window.__frames);
    const light = log.filter((f) => !f.dark && f.bg === "rgb(243, 244, 248)");
    console.log("service worker controlling:", sw);
    console.log("rendered frames before .dark:", JSON.stringify(log.slice(0, 6)));
    // Save the first screencast frame that shows the light background as evidence.
    const p2 = await context.newPage();
    for (const data of frames) {
      const px = await p2.evaluate(async (d) => {
        const img = new Image(); img.src = "data:image/png;base64," + d; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0);
        return [...x.getImageData(5, img.height - 5, 1, 1).data].slice(0, 3).join(",");
      }, data);
      if (px === "243,244,248") { require("fs").writeFileSync(__dirname + "/shots/ui-2-light-frame.png", Buffer.from(data, "base64")); console.log("screencast captured a light frame -> shots/ui-2-light-frame.png"); break; }
    }
    if (light.length) {
      const firstDark = log.find((f) => f.dark);
      const span = (firstDark ? firstDark.t : light[light.length - 1].t) - light[0].t;
      console.log(`REPRODUCED: dark theme saved, but the page rendered with the light background rgb(243,244,248) for ~${span}ms (${light.length} frames) before .dark applied`);
      process.exitCode = 1;
    } else {
      console.log("NOT REPRODUCED");
      process.exitCode = 0;
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(2); });
