/**
 * Responsibility: Pins signing out on a device: a warning naming the work
 *   that has not synced, staying signed in to keep it, and a confirmed
 *   sign-out that leaves none of the user's data but keeps device settings.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, tests/fixtures/localDateTime.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { localDateTime } from "../fixtures/localDateTime";

const HOME = "Your fleet, at a glance.";
const HOUR_MS = 60 * 60 * 1000;
const PHOTO = path.resolve("public/icon-192.png");

test("warns before deleting unsynced work, keeps it on Stay signed in, and deletes it only when confirmed", async ({
  page,
  context,
}) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: "Favorite N206MA", exact: true })
    .click();
  await page.evaluate(() => localStorage.setItem("angelone-theme", "dark"));
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await context.setOffline(true);
  await logFlightWithPhoto(page);
  await expect(
    page.getByText("1 entry waiting to send · Offline"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const warning = page.getByRole("dialog", {
    name: "1 entry and 1 photo haven't synced",
  });
  await expect(warning).toContainText(
    "Signing out deletes them from this device.",
  );
  await warning.getByRole("button", { name: "Stay signed in" }).click();
  await expect(warning).not.toBeVisible();
  await expect(
    page.getByText("1 entry waiting to send · Offline"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    warning.getByRole("button", { name: "Delete and sign out" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: HOME })).toBeVisible();
  expect(await deviceRecords(page)).toEqual({
    outbox: 0,
    photos: 0,
    favorites: false,
    theme: "dark",
  });
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
});

test("signs out at once when everything has synced", async ({ page }) => {
  await openDemo(page);
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  await expect(page.getByRole("heading", { name: HOME })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/**
 * Opens the demo with the service worker controlling the page, so it still
 * loads after an offline sign-out reloads it.
 */
async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  const home = page.getByRole("heading", { name: HOME });
  await expect(home).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(home).toBeVisible();
}

/** Logs a one-hour flight on N206MA and attaches a logbook page photo. */
async function logFlightWithPhoto(page: Page) {
  await page
    .getByRole("button", { name: "Log a completed flight", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const aircraft = dialog.getByLabel("Aircraft", { exact: true });
  const option = aircraft.locator("option").filter({ hasText: "N206MA" });
  await aircraft.selectOption(await option.getAttribute("value"));
  await dialog
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - HOUR_MS));
  const starting = Number(
    await dialog.getByLabel("Starting Hobbs (hours)").inputValue(),
  );
  await dialog
    .getByLabel("Ending Hobbs", { exact: false })
    .fill((starting + 1).toFixed(1));
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const prompt = page.locator(".lp-prompt");
  await prompt.locator("input[type=file]").setInputFiles(PHOTO);
  await expect(
    prompt.getByRole("img", { name: "icon-192.png, waiting to upload" }),
  ).toBeVisible();
}

/** What the device still holds for the demo user after signing out. */
async function deviceRecords(page: Page) {
  return page.evaluate(async () => {
    const open = (name: string) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    const read = <T>(db: IDBDatabase, store: string, op: string) =>
      new Promise<T>((resolve, reject) => {
        const source = db.transaction(store).objectStore(store);
        const request =
          op === "count" ? source.count() : source.get("demo:demo-admin");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as T);
      });
    const cache = await open("angel-one-v1");
    const photos = await open("angel-one-logbook-photos-v1");
    const records = {
      outbox: await read<number>(cache, "outbox", "count"),
      photos: await read<number>(photos, "photos", "count"),
      favorites: (await read(cache, "settings", "get")) !== undefined,
      theme: localStorage.getItem("angelone-theme"),
    };
    cache.close();
    photos.close();
    return records;
  });
}
