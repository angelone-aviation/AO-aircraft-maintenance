/**
 * Responsibility: Measures how much a signed-in device downloads: on first
 *   load, and again when another user changes one small thing in the
 *   program.
 * Layer: Script. Load test only; refuses any backend or app address but a
 *   local one.
 * Dependencies: ./browserCommon.mjs, ./common.mjs, ./guard.mjs, node:crypto.
 *
 *   node scripts/loadtest/wsbytes.mjs --step y01
 * Counts the WebSocket payload bytes the page receives (CDP Network domain)
 * and appends to DATA_DIR/results/browser.jsonl.
 */
import { randomUUID } from "node:crypto";
import {
  clickSignIn,
  fillSignIn,
  launchBrowser,
} from "./browserCommon.mjs";
import {
  api,
  appendResult,
  DATA_DIR,
  readJson,
  signIn,
} from "./common.mjs";
import { localAppUrl } from "./guard.mjs";

const SIGN_IN_TIMEOUT_MS = 60_000;
// Long enough for the first snapshot, then for the change to arrive.
const FIRST_LOAD_SETTLE_MS = 6_000;
const CHANGE_SETTLE_MS = 8_000;

const appUrl = localAppUrl();
const step = process.argv[process.argv.indexOf("--step") + 1];
const accounts = readJson(`${DATA_DIR}/accounts.json`);
try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}

async function main() {
  const browser = await launchBrowser();
  const page = await (await browser.newContext()).newPage();
  const received = await countWebSocketBytes(page);
  await page.goto(appUrl);
  await fillSignIn(page, accounts.users.find((u) => u.role === "pilot"));
  await clickSignIn(page);
  await page.getByRole("link", { name: "Overview", exact: true }).waitFor({ timeout: SIGN_IN_TIMEOUT_MS });
  await page.waitForTimeout(FIRST_LOAD_SETTLE_MS);
  const first = received.take();
  await reportProblemAsMechanic();
  await page.waitForTimeout(CHANGE_SETTLE_MS);
  const afterChange = received.take();
  await browser.close();
  appendResult({
    step, area: "browser", name: "WebSocket bytes received (first load; then after one new problem report by another user)", role: "pilot",
    ok: true, ms: [], medianMs: null, bytes: afterChange.bytes, error: null, extra: { first, afterChange }, at: new Date().toISOString(),
  });
  console.log(step, JSON.stringify({ first, afterChange }));
}

// `take()` returns the bytes and frames since the last take.
async function countWebSocketBytes(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let bytes = 0;
  let frames = 0;
  cdp.on("Network.webSocketFrameReceived", (e) => {
    bytes += e.response.payloadData.length;
    frames++;
  });
  return {
    take() {
      const counted = { bytes, frames };
      bytes = 0;
      frames = 0;
      return counted;
    },
  };
}

// One small change by someone else: the mechanic reports a problem.
async function reportProblemAsMechanic() {
  const mechanic = accounts.users.find((u) => u.role === "mechanic");
  const client = await signIn(mechanic.email, mechanic.password);
  await client.mutation(api.operations.submit, {
    operation: { programUuid: accounts.programUuid, kind: "discrepancy", uuid: randomUUID(), authorId: mechanic.id, aircraftUuid: accounts.aircraft[4].uuid, description: "Size test: cabin light lens cracked." },
  });
}
