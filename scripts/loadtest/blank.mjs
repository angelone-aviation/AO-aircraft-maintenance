/**
 * Responsibility: Shows what a user sees once the workspace snapshot fails on
 *   the server: signs a pilot in through the production build and reports
 *   the screen, before and after a reload.
 * Layer: Script. Load test only; refuses any backend or app address but a
 *   local one.
 * Dependencies: ./browserCommon.mjs, ./common.mjs, ./guard.mjs.
 *
 *   node scripts/loadtest/blank.mjs      (after loading 3 or more years)
 * Prints REPRODUCED and exits 1 when the page is blank with no message.
 * SHOT overrides where the screenshot goes.
 */
import {
  clickSignIn,
  fillSignIn,
  isBlank,
  launchBrowser,
  readScreen,
  VIEWPORT,
} from "./browserCommon.mjs";
import { DATA_DIR, readJson, shotPath } from "./common.mjs";
import { localAppUrl } from "./guard.mjs";

// Long enough for the snapshot query to fail and the app to react.
const SIGN_IN_SETTLE_MS = 15_000;
const RELOAD_SETTLE_MS = 8_000;
const TEXT_LIMIT = 300;
const ERROR_LIMIT = 400;
const ERRORS_SHOWN = 4;

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}

async function main() {
  const appUrl = localAppUrl();
  const pilot = readJson(`${DATA_DIR}/accounts.json`).users.find((u) => u.role === "pilot");
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const errors = collectErrors(page);
  await page.goto(appUrl);
  await fillSignIn(page, pilot);
  await clickSignIn(page);
  await page.waitForTimeout(SIGN_IN_SETTLE_MS);
  const screen = await readScreen(page, TEXT_LIMIT);
  await page.screenshot({ path: process.env.SHOT || shotPath("blank-after-snapshot-failure.png") });
  await page.reload();
  await page.waitForTimeout(RELOAD_SETTLE_MS);
  const afterReload = await readScreen(page, TEXT_LIMIT);
  await browser.close();
  console.log(JSON.stringify({ screen, afterReload, errors: errors.slice(0, ERRORS_SHOWN) }, null, 1));
  if (!isBlank(screen)) {
    console.log("NOT REPRODUCED");
    return 0;
  }
  console.log(`REPRODUCED: after sign-in the page is blank (the app unmounted) with no message; reload stays ${afterReload.rootChildren === 0 ? "blank" : "not blank"}`);
  return 1;
}

function collectErrors(page) {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, ERROR_LIMIT)));
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, ERROR_LIMIT)));
  return errors;
}
