/**
 * Responsibility: Pins the app update flow: a waiting service worker is
 *   offered as "A new version is ready", Reload now activates it and reloads
 *   the page, and the install notice never asks a user already in the
 *   workspace to sign in.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:http, node:fs, node:path.
 *
 * The spec serves the build itself, so it can switch to a "next build":
 * the same files with one more byte in the worker script. The browser
 * installs any changed worker as a new version, which waits because the app
 * asks before activating it (registerType "prompt"). Playwright's routing
 * cannot stand in, since it never sees the browser's worker update check.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { test, expect, type Page } from "@playwright/test";

const DIST = resolve("dist");
const WORKER_PATH = "/sw.js";
const UPDATE_TEXT = "A new version is ready. Save any open form first.";
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

let server: Server;
let origin = "";
let nextBuild = false;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    void serveFile(new URL(request.url ?? "/", "http://local").pathname).then(
      ({ status, type, body }) => {
        response.writeHead(status, {
          "Content-Type": type,
          "Cache-Control": "no-cache",
        });
        response.end(body);
      },
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((done) => server.close(() => done())));
test.beforeEach(() => {
  nextBuild = false;
});

for (const viewport of VIEWPORTS)
  test(`Reload now applies a waiting update on a ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openControlledDemo(page);
    const notice = await publishNextBuild(page);

    await page.evaluate(() => Object.assign(window, { beforeReload: true }));
    const reloaded = page.waitForEvent("load");
    await notice.getByRole("button", { name: "Reload now" }).click();
    await reloaded;
    expect(await page.evaluate(() => "beforeReload" in window)).toBe(false);
    await expect(
      page.getByRole("heading", { name: "Your fleet, at a glance." }),
    ).toBeVisible();
    await expect(page.getByText(UPDATE_TEXT)).toHaveCount(0);
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return !registration?.waiting && !!navigator.serviceWorker.controller;
      }),
    ).toBe(true);
  });

test("the update notice can be dismissed from the keyboard", async ({
  page,
}) => {
  await openControlledDemo(page);
  await publishNextBuild(page);
  await page.getByRole("button", { name: "Dismiss update notice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(UPDATE_TEXT)).toHaveCount(0);
  expect(
    await page.evaluate(
      async () => !!(await navigator.serviceWorker.getRegistration())?.waiting,
    ),
  ).toBe(true);
});

/**
 * Opens the demo, checks the first install's notice, and reloads so the
 * installed service worker controls the page.
 */
async function openControlledDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(origin + "/");
  await expect(
    page.getByText("App installed for offline use.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Sign in online/)).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

/** Serves the next build, asks the browser to check for it, and returns the
 * update notice it should raise. */
async function publishNextBuild(page: Page) {
  nextBuild = true;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  const notice = page.getByRole("status").filter({ hasText: UPDATE_TEXT });
  await expect(notice).toBeVisible();
  return notice;
}

// The single-page-app fallback mirrors scripts/serve-dist.mjs: a path with
// no file extension opens the app shell.
async function serveFile(path: string) {
  const file = extname(path) ? normalize(path) : "/index.html";
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  try {
    const body = await readFile(join(DIST, file));
    if (file !== WORKER_PATH || !nextBuild) return { status: 200, type, body };
    return { status: 200, type, body: body + "\n// next build\n" };
  } catch {
    // A file the build does not have is a 404, as on the real host.
    return { status: 404, type: "text/plain", body: "Not found" };
  }
}
