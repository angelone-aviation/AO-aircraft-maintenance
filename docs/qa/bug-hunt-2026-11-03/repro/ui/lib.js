// Shared exploration helpers (repro scripts inline their own copies).
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
const DIR = __dirname;
async function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}
async function ctx(browser, { w = 1280, h = 800, dark = false, reduce = false, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    reducedMotion: reduce ? "reduce" : "no-preference",
    isMobile: mobile,
    hasTouch: mobile,
  });
  if (dark)
    await context.addInitScript(() => localStorage.setItem("angelone-theme", "dark"));
  return context;
}
async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Explore the local demo/ }).click();
  await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor({ timeout: 30000 });
}
async function overflow(page) {
  return page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    vw: window.innerWidth,
    cw: document.documentElement.clientWidth,
  }));
}
module.exports = { chromium, BASE, DIR, launch, ctx, signIn, overflow };
