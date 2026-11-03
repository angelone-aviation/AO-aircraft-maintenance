const path = require("path");
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
const SHOTS = path.join(__dirname, "shots");
async function start(opts = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ...opts });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Explore the local demo/i }).click();
  await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
  return { browser, context, page };
}
// Mutate the demo snapshot in IndexedDB, then reload.
async function patchSnapshot(page, fnSource, arg) {
  await page.evaluate(async ({ fnSource, arg }) => {
    const fn = new Function("s", "arg", fnSource);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readwrite");
        const cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          fn(s, arg);
          entry.update(s);
          entry.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { fnSource, arg });
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => {});
}
async function readSnapshot(page) {
  return page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readonly");
        const all = tx.objectStore("snapshots").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result); };
        all.onerror = () => reject(all.error);
      };
    });
  });
}
function localDate(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftDays(days) { return localDate(Date.now() + days * 86400000); }
function result(bug, msg) {
  if (bug) { console.log("REPRODUCED: " + msg); process.exitCode = 1; }
  else { console.log("NOT REPRODUCED"); process.exitCode = 0; }
}
module.exports = { start, patchSnapshot, readSnapshot, BASE, SHOTS, localDate, shiftDays, result, path };
