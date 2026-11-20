/**
 * Responsibility: The returning user of the size test: a device that already
 *   holds the offline copy, reopened after the snapshot starts failing,
 *   online and then offline.
 * Layer: Script. Load test only; refuses any backend or app address but a
 *   local one.
 * Dependencies: ./browserCommon.mjs, ./common.mjs, ./guard.mjs.
 *
 *   node scripts/loadtest/returning.mjs prime        while the snapshot works
 *   node scripts/loadtest/returning.mjs check y03    after it fails
 * "prime" signs a pilot in with a persistent browser profile in
 * DATA_DIR/browser-profile; "check" reopens it, appends to
 * DATA_DIR/results/browser.jsonl, and prints REPRODUCED (exit 1) when the
 * page online is blank.
 */
import {
  clickSignIn,
  fillSignIn,
  isBlank,
  launchProfile,
  readScreen,
} from "./browserCommon.mjs";
import { appendResult, DATA_DIR, readJson, shotPath } from "./common.mjs";
import { localAppUrl } from "./guard.mjs";

const SIGN_IN_TIMEOUT_MS = 60_000;
// Long enough for the stored copy to be saved, and for a failing snapshot to
// show what it shows.
const PRIME_SETTLE_MS = 8_000;
const CHECK_SETTLE_MS = 20_000;
const OFFLINE_SETTLE_MS = 8_000;
const ONLINE_TEXT_LIMIT = 200;
const OFFLINE_TEXT_LIMIT = 120;
const ERROR_LIMIT = 300;

const appUrl = localAppUrl();
const [mode, step = ""] = process.argv.slice(2);
try {
  process.exitCode = await (mode === "prime" ? prime() : check());
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}

async function openProfile() {
  const context = await launchProfile(`${DATA_DIR}/browser-profile`);
  const page = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, ERROR_LIMIT)));
  await page.goto(appUrl);
  return { context, page, errors };
}

async function prime() {
  const { context, page } = await openProfile();
  const pilot = readJson(`${DATA_DIR}/accounts.json`).users.find((u) => u.role === "pilot");
  await fillSignIn(page, pilot);
  await clickSignIn(page);
  await page.getByRole("link", { name: "Overview", exact: true }).waitFor({ timeout: SIGN_IN_TIMEOUT_MS });
  await page.getByText("N501LT").first().waitFor({ timeout: SIGN_IN_TIMEOUT_MS });
  await page.waitForTimeout(PRIME_SETTLE_MS);
  console.log("primed: signed in and offline copy stored");
  await context.close();
  return 0;
}

async function check() {
  const { context, page, errors } = await openProfile();
  await page.waitForTimeout(CHECK_SETTLE_MS);
  const screen = await readScreen(page, ONLINE_TEXT_LIMIT);
  await page.screenshot({ path: shotPath("returning-user-after-failure.png") });
  await context.setOffline(true);
  // Offline the reload can fail before the service worker answers; the
  // screen is read either way.
  await page.reload().catch((error) => console.warn("Offline reload:", String(error).slice(0, ERROR_LIMIT)));
  await page.waitForTimeout(OFFLINE_SETTLE_MS);
  const offline = await readScreen(page, OFFLINE_TEXT_LIMIT);
  await context.close();
  const ok = !isBlank(screen);
  appendResult({
    step, area: "browser", name: "returning user with an offline copy, after the snapshot fails", role: "pilot",
    ok, ms: [], medianMs: null, bytes: null, error: errors[0] ?? null, extra: { screen, offline }, at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ screen, offline }), errors[0] ?? "");
  console.log(ok ? "NOT REPRODUCED" : "REPRODUCED: a returning user online sees a blank page; offline: " + JSON.stringify(offline));
  return ok ? 0 : 1;
}
