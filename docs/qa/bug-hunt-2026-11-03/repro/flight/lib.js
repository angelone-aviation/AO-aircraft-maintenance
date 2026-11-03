// Shared helpers for flight-area repro scripts.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const BASE = process.env.ANGELONE_URL || "http://127.0.0.1:4200";
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

async function start(opts = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    ...opts,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Explore the local demo/i }).click();
  await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
  return { browser, context, page };
}

// Wait for the service worker so offline reloads work.
async function swReady(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
}

async function patchSnapshot(page, fnSource, arg) {
  await page.evaluate(
    async ({ fnSource, arg }) => {
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
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { fnSource, arg },
  );
  await page.reload();
}

// Returns { key: snapshot } for every stored snapshot.
async function readSnapshots(page) {
  return page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readonly");
        const store = tx.objectStore("snapshots");
        const keys = store.getAllKeys();
        const all = store.getAll();
        tx.oncomplete = () => {
          db.close();
          const out = {};
          keys.result.forEach((k, i) => (out[k] = all.result[i]));
          resolve(out);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}
async function demoAll(page) {
  const snaps = await readSnapshots(page);
  return snaps["demo:all"] ?? snaps["demo"];
}

// Local datetime-local string for an epoch ms in the page's timezone.
async function pageLocal(page, ms) {
  return page.evaluate((ms) => {
    const d = new Date(ms);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }, ms);
}

async function openLogFlight(page, registration) {
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await page
    .getByRole("button", { name: "Log a completed flight", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  if (registration) {
    const select = dialog.getByLabel("Aircraft", { exact: true });
    const option = select.locator("option").filter({ hasText: registration });
    await select.selectOption((await option.getAttribute("value")));
  }
  return dialog;
}

function result(bug, msg) {
  if (bug) {
    console.log("REPRODUCED: " + msg);
    process.exitCode = 1;
  } else {
    console.log("NOT REPRODUCED");
    process.exitCode = 0;
  }
}
module.exports = {
  start,
  swReady,
  patchSnapshot,
  readSnapshots,
  demoAll,
  pageLocal,
  openLogFlight,
  result,
  BASE,
  SHOTS,
  path,
};
