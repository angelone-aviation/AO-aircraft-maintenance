/**
 * Responsibility: Pins the list searches: the flight log's search, aircraft
 *   filter, status counts and Show more over 120 stored flights, and the
 *   discrepancy search, at desktop and phone sizes.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const FLIGHTS = 120;

test("flight log searches, filters by aircraft and shows 50 flights at a time", async ({
  page,
}) => {
  await demo(page);
  await storeFlights(page, FLIGHTS);
  await page.goto("/flights");
  const rows = page.locator(".rec-table tbody tr");
  // The Show more count, not the older-history pager's "Showing the last".
  const pager = page
    .getByRole("status")
    .filter({ hasText: /^Showing \d+ of \d+ flights/ });
  const more = page.getByRole("button", { name: "Show more", exact: true });
  await expect(rows).toHaveCount(50);
  await expect(pager).toHaveText("Showing 50 of 120 flights");
  // Newest first: flight 120 starts last.
  await expect(rows.first()).toContainText("KF120");
  await more.click();
  await expect(rows).toHaveCount(100);
  await more.click();
  await expect(rows).toHaveCount(120);
  await expect(more).toHaveCount(0);
  await expect(pager).toBeFocused();

  const search = page.getByRole("searchbox", { name: "Search flights" });
  await search.fill("kpae");
  await expect(rows).toHaveCount(12);
  await expect(pager).toHaveCount(0);
  await expect(statusChoice(page, "All flights")).toContainText("12");
  await search.fill("Medevac");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("KF007");
  await search.fill("Jordan");
  await expect(rows).toHaveCount(50);
  await expect(pager).toHaveText("Showing 50 of 60 flights");
  await search.fill("");

  const aircraft = page.getByLabel("Aircraft", { exact: true });
  await aircraft.selectOption({ label: "N208MA" });
  await expect(pager).toHaveText("Showing 50 of 60 flights");
  await expect(statusChoice(page, "All flights")).toContainText("60");
  // Every tenth flight is even, so on N208MA, and held for review.
  await expect(statusChoice(page, "Needs review")).toContainText("12");
  await statusChoice(page, "Needs review").click();
  await expect(rows).toHaveCount(12);
  await search.fill("no flight matches this");
  await expect(
    page.getByText("Try another search, aircraft or status."),
  ).toBeVisible();
});

test("flight log search works on the phone cards", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await demo(page);
  await storeFlights(page, FLIGHTS);
  await page.goto("/flights");
  const cards = page.locator(".rec-flight-card");
  await expect(cards).toHaveCount(50);
  await page.getByRole("searchbox", { name: "Search flights" }).fill("KF042");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("KF042");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("discrepancy search narrows the reports and keeps the counts", async ({
  page,
}) => {
  await demo(page);
  await page.goto("/discrepancies");
  const search = page.getByRole("searchbox", { name: "Search reports" });
  const report = page.getByText("Left landing light is intermittent.", {
    exact: false,
  });
  await search.fill("landing light");
  await expect(report).toBeVisible();
  await search.fill("N208");
  await expect(report).toBeVisible();
  await search.fill("N206");
  await expect(report).toHaveCount(0);
  await expect(page.getByText("No matching reports")).toBeVisible();
  await expect(
    page
      .locator(".disc-stats .ds-stat-tile")
      .filter({ hasText: "Open" })
      .locator(".ds-stat-value"),
  ).toHaveText("1");
});

/** The flight log's status choice with this label. */
function statusChoice(page: Page, label: string) {
  return page
    .getByRole("group", { name: "Flight status" })
    .getByRole("button", { name: label, exact: true });
}

/** Opens the demo with the service worker controlling the page. */
async function demo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  const home = page.getByRole("heading", { name: "Your fleet, at a glance." });
  await expect(home).toBeVisible();
  // The service worker controls only pages loaded after it activates.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(home).toBeVisible();
}

/**
 * Stores `count` flights, one a day from 1 Jan 2026, in every snapshot on
 * the device: odd ones on N206MA by the administrator, even ones on N208MA
 * by Jordan Lee, origin KF001 onwards, every tenth to KPAE and held for
 * review, and flight 7 remarked "Medevac".
 */
async function storeFlights(page: Page, count: number) {
  await page.evaluate(async (total) => {
    // One a day up to yesterday, all within the six months of flights the
    // workspace keeps (ADR-0013), flight `total` newest.
    const day = 86_400_000;
    const flights = Array.from({ length: total }, (_, i) => {
      const n = i + 1;
      const tenth = n % 10 === 0;
      const at = Date.now() - (total - i) * day;
      return {
        uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        aircraftUuid: n % 2 ? "demo-206" : "demo-208",
        authorId: "demo-admin",
        pilotId: n % 2 ? "demo-admin" : "demo-pilot",
        submittedAt: at,
        status: tenth ? "review" : "accepted",
        startTime: new Date(at).toISOString(),
        landings: 1,
        cycles: 0,
        origin: `KF${String(n).padStart(3, "0")}`,
        destination: tenth ? "KPAE" : "KBFI",
        operation: "Mission",
        flightRules: "VFR",
        remarks: n === 7 ? "Medevac to Spokane" : "",
        discrepancy: "",
      };
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("snapshots", "readwrite");
    const cursor = tx.objectStore("snapshots").openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      entry.update({ ...entry.value, flights });
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, count);
  await page.reload();
}
