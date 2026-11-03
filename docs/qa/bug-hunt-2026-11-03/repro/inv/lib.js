const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
async function start(opts = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ...opts });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(BASE + "/");
  const btn = page.getByRole("button", { name: /Explore the local demo/i });
  await btn.click();
  await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
  return { browser, context, page };
}
async function go(page, path) {
  await page.goto(BASE + path);
}
async function snapshot(page) {
  return page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("snapshots", "readonly");
        const all = tx.objectStore("snapshots").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result); };
      };
    });
  });
}
async function mutate(page, fnSrc, arg) {
  return page.evaluate(async ({ fnSrc, arg }) => {
    const fn = new Function("s", "arg", fnSrc);
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction("snapshots", "readwrite"), cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => { const e = cursor.result; if (!e) return; const s = e.value; fn(s, arg); e.update(s); e.continue(); };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { fnSrc, arg });
}
function result(bug, msg) {
  if (bug) { console.log("REPRODUCED: " + msg); process.exitCode = 1; }
  else { console.log("NOT REPRODUCED"); process.exitCode = 0; }
}
module.exports = { start, go, snapshot, mutate, result, BASE };
function loc(uuid, name) {
  return { kind: "location", uuid, programUuid: "demo-program", version: 1, name, address: "", contact: "" };
}
function stock(uuid, locationUuid, partNumber, extra = {}) {
  return { kind: "stock", uuid, programUuid: "demo-program", version: 1, locationUuid, partNumber,
    description: extra.description ?? partNumber + " desc", quantity: 5, minimum: 0, alternates: "",
    category: "part", condition: "new", ...extra };
}
async function seed(page, records, extraFn) {
  await mutate(page, `s.management = [...(s.management||[]), ...arg.records]; delete s.partsInventory; ${extraFn || ""}`, { records });
  await page.reload();
}
module.exports.loc = loc; module.exports.stock = stock; module.exports.seed = seed;
