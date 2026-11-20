/**
 * Responsibility: The browser pass of the size test: times sign-in to a
 *   usable Overview and the Flights list on the production build, at normal
 *   speed and with a 4x CPU slowdown, and measures the offline copy.
 * Layer: Script. Load test only; refuses any backend or app address but a
 *   local one.
 * Dependencies: ./browserCommon.mjs, ./common.mjs, ./guard.mjs.
 *
 *   node scripts/loadtest/browser.mjs --step y01
 * Appends to DATA_DIR/results/browser.jsonl; screenshots go to
 * DATA_DIR/shots.
 */
import {
  clickSignIn,
  fillSignIn,
  launchBrowser,
  readScreen,
  VIEWPORT,
} from "./browserCommon.mjs";
import { appendResult, DATA_DIR, readJson, shotPath } from "./common.mjs";
import { localAppUrl } from "./guard.mjs";

const OVERVIEW = "Your fleet, at a glance.";
// The fleet cards have rendered once a registration shows.
const FIRST_REGISTRATION = "N501LT";
const SEEDED_AIRPORTS = /KCHA|KAVL|KBNA/;
const OVERVIEW_TIMEOUT_MS = 45_000;
const FLIGHTS_TIMEOUT_MS = 120_000;
const SLOW_CPU = 4;
const TEXT_LIMIT = 300;
const ERRORS_KEPT = 5;
const LOG_LIMIT = 300;
// The app's IndexedDB database (src/data/local.ts).
const APP_DATABASE = "angel-one-v1";

const appUrl = localAppUrl();
const step = process.argv[process.argv.indexOf("--step") + 1];
const accounts = readJson(`${DATA_DIR}/accounts.json`);
try {
  const browser = await launchBrowser();
  const pilot = accounts.users.find((u) => u.role === "pilot");
  await pass(browser, "admin", accounts.admin, 1);
  await pass(browser, "admin", accounts.admin, SLOW_CPU);
  await pass(browser, "pilot", pilot, 1);
  await browser.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

function record(name, role, result) {
  const line = {
    step, area: "browser", name, role, ok: result.ok, ms: result.ms ?? [], medianMs: result.ms?.[0] ?? null,
    bytes: result.bytes ?? null, error: result.error ?? null, extra: result.extra ?? {}, at: new Date().toISOString(),
  };
  appendResult(line);
  console.log(step, name, role, result.ok ? "ok" : "FAILED", line.medianMs, result.bytes ?? "", result.error ?? "", JSON.stringify(line.extra).slice(0, LOG_LIMIT));
}

async function pass(browser, role, account, throttle) {
  const label = throttle > 1 ? `${throttle}x CPU` : "normal";
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    const cdp = await context.newCDPSession(page);
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    const signedIn = await timeSignIn(page, account, errors);
    record(`sign-in to Overview (${label})`, role, signedIn);
    await page.screenshot({ path: shotPath(`${step}-${role}-${throttle}x-overview.png`) });
    if (signedIn.ok) await measureWorkspace(page, role, throttle, label);
  } finally {
    await context.close();
  }
}

function collectErrors(page) {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, LOG_LIMIT)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, LOG_LIMIT)));
  return errors;
}

async function timeSignIn(page, account, errors) {
  await page.goto(appUrl);
  await fillSignIn(page, account);
  const started = Date.now();
  await clickSignIn(page);
  const error = await failureOf(() => openOverview(page));
  // What is on screen when it did not work: text and how much is mounted.
  const screen = error ? await readScreen(page, TEXT_LIMIT) : null;
  return { ok: !error, ms: [Date.now() - started], error, extra: { errors: errors.slice(0, ERRORS_KEPT), screen } };
}

async function openOverview(page) {
  const overview = page.getByRole("link", { name: "Overview", exact: true });
  await overview.waitFor({ timeout: OVERVIEW_TIMEOUT_MS });
  await overview.click();
  await page.getByRole("heading", { name: OVERVIEW }).waitFor({ timeout: OVERVIEW_TIMEOUT_MS });
  await page.getByText(FIRST_REGISTRATION).first().waitFor({ timeout: OVERVIEW_TIMEOUT_MS });
}

// A timeout here is the measurement: the step is too large for the screen.
async function failureOf(steps) {
  try {
    await steps();
    return null;
  } catch (error) {
    return String(error).split("\n")[0].slice(0, LOG_LIMIT);
  }
}

async function measureWorkspace(page, role, throttle, label) {
  const flights = await timeFlights(page);
  record(`Flights list (${label})`, role, flights);
  await page.screenshot({ path: shotPath(`${step}-${role}-${throttle}x-flights.png`) });
  if (flights.ok) record(`Flights list again (${label})`, role, await timeFlightsAgain(page));
  const usage = await page.evaluate(readOfflineCopy, APP_DATABASE);
  record(`offline copy (${label})`, role, { ok: true, bytes: usage.details?.indexedDB ?? usage.usage, extra: usage });
}

async function timeFlights(page) {
  const started = Date.now();
  let elements = null;
  const error = await failureOf(async () => {
    await openFlights(page);
    elements = await page.locator("tr, li, article").count();
  });
  return { ok: !error, ms: [Date.now() - started], error, extra: { elements } };
}

async function openFlights(page) {
  await page.getByRole("link", { name: "Flight log", exact: true }).first().click();
  await page.getByText(SEEDED_AIRPORTS).first().waitFor({ timeout: FLIGHTS_TIMEOUT_MS });
}

// A second visit, with the data already in memory: pure render cost.
async function timeFlightsAgain(page) {
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: OVERVIEW }).waitFor();
  const started = Date.now();
  await openFlights(page);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return { ok: true, ms: [Date.now() - started] };
}

// Runs in the page: the storage estimate and the JSON size of every value in
// the app's database, store by store.
async function readOfflineCopy(databaseName) {
  const estimate = await navigator.storage.estimate();
  const databases = (await indexedDB.databases?.()) ?? [];
  return { usage: estimate.usage, details: estimate.usageDetails ?? null, dbs: databases.map((d) => d.name), stores: await storeSizes() };

  function settle(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function storeSizes() {
    let database;
    try {
      database = await settle(indexedDB.open(databaseName));
    } catch (error) {
      // An unopenable database is reported, not fatal to the pass.
      return { error: String(error) };
    }
    const sizes = {};
    for (const name of database.objectStoreNames) sizes[name] = await storeSize(database, name);
    return sizes;
  }
  async function storeSize(database, name) {
    try {
      const values = await settle(database.transaction(name).objectStore(name).getAll());
      return [values.length, values.reduce((n, v) => n + JSON.stringify(v ?? null).length, 0)];
    } catch {
      // One unreadable store is marked, and the others still counted.
      return "error";
    }
  }
}
