const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
const OUT = __dirname + "/../shots";
require("fs").mkdirSync(OUT, { recursive: true });
async function start() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto("/");
  await page.getByRole("button", { name: /Explore the local demo/ }).click();
  await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
  return { browser, context, page };
}
async function nav(page, name) {
  await page.getByRole("link", { name, exact: true }).first().click();
}
// Edits every stored demo snapshot in IndexedDB, then reloads.
async function patchSnapshots(page, fn, arg) {
  await page.evaluate(
    ([src, a]) =>
      new Promise((resolve, reject) => {
        const f = eval("(" + src + ")");
        const request = indexedDB.open("angel-one-v1");
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("snapshots", "readwrite"),
            cursor = tx.objectStore("snapshots").openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            const s = entry.value;
            if (s && s.user) {
              f(s, a, entry.key);
              entry.update(s);
            }
            entry.continue();
          };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [fn.toString(), arg],
  );
  await page.reload();
  await page.locator("main").first().waitFor(); await page.waitForTimeout(800);
}
async function snapshotKeys(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open("angel-one-v1");
    r.onsuccess = () => {
      const db = r.result; const tx = db.transaction("snapshots"); const req = tx.objectStore("snapshots").getAllKeys();
      req.onsuccess = () => resolve(req.result);
    };
  }));
}
function finish(bug, msg) {
  if (bug) { console.log("REPRODUCED: " + msg); process.exitCode = 1; }
  else { console.log("NOT REPRODUCED"); process.exitCode = 0; }
}
module.exports = { start, nav, patchSnapshots, snapshotKeys, finish, OUT, BASE };
