/**
 * Responsibility: What the load test's browser scripts share: launching
 *   Chromium, signing in through the app's own form, and reading what is on
 *   screen.
 * Layer: Script. Load test only; drives a local production build.
 * Dependencies: playwright.
 */
import { chromium } from "playwright";

/** The desktop window every browser measurement uses. */
export const VIEWPORT = { width: 1280, height: 900 };

/**
 * Playwright launch options, with CHROMIUM_PATH as the browser when
 * Playwright cannot find its own.
 *
 * @param options - Any other launch options.
 */
export function launchOptions(options = {}) {
  const executablePath = process.env.CHROMIUM_PATH;
  return executablePath ? { ...options, executablePath } : options;
}

/** Starts Chromium as {@link launchOptions} describes. */
export function launchBrowser() {
  return chromium.launch(launchOptions());
}

/**
 * Opens a page in a persistent profile, so the app's offline copy outlives
 * the browser.
 *
 * @param folder - The profile folder.
 */
export function launchProfile(folder) {
  return chromium.launchPersistentContext(
    folder,
    launchOptions({ viewport: VIEWPORT }),
  );
}

/**
 * Types a test account's email and password into the sign-in form; the
 * caller presses Sign in ({@link clickSignIn}), so it can time from there.
 *
 * @param page - A page on the sign-in screen.
 * @param account - An entry of accounts.json.
 */
export async function fillSignIn(page, account) {
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
}

/**
 * Presses the sign-in form's Sign in button.
 *
 * @param page - A page with the form filled.
 */
export function clickSignIn(page) {
  return page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * What is on screen: the start of the visible text and how much of the app
 * is mounted.
 *
 * @param page - The page.
 * @param maxCharacters - The most characters of text kept.
 * @returns `text` and `rootChildren` (null without the #root element).
 */
export function readScreen(page, maxCharacters) {
  return page.evaluate(
    (max) => ({
      text: document.body.innerText.trim().slice(0, max),
      rootChildren: document.getElementById("root")?.childElementCount ?? null,
    }),
    maxCharacters,
  );
}

/**
 * Whether the app unmounted with no message: the failure the size test
 * looks for once the snapshot is too large.
 *
 * @param screen - From {@link readScreen}.
 */
export function isBlank(screen) {
  return screen.rootChildren === 0 && screen.text === "";
}
