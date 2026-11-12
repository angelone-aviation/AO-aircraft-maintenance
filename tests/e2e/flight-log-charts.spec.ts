/**
 * Responsibility: Pins the flight log's weekly charts: both figures and
 *   their data tables follow the stored flights and the filters, the plots
 *   draw, and a phone does not mount them.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const HOUR_SECONDS = 3600;
const HOURS_CHART = "Hobbs hours flown per week";
const FLIGHTS_CHART = "Flights per week";

test("flight log charts hours and flights by week for the flights in view", async ({
  page,
}) => {
  await demo(page);
  await storeFlights(page);
  await page.goto("/flights");
  const hours = page.getByRole("figure", { name: HOURS_CHART });
  const flights = page.getByRole("figure", { name: FLIGHTS_CHART });
  await expect(hours).toBeVisible();
  await expect(flights).toBeVisible();
  await expect(hours.locator(".recharts-surface")).toBeVisible();
  await expect(flights.locator(".recharts-surface")).toBeVisible();

  // Twelve weeks, oldest first, ending with the week of the newest flight:
  // Monday 9 Nov 2026 has two flights (1.5 h and 2.0 h), 2 Nov has one.
  const hourRows = hours.locator("tbody tr");
  await expect(hourRows).toHaveCount(12);
  await expect(hourRows.last()).toHaveText("Nov 93.5 h");
  await expect(hourRows.nth(10)).toHaveText("Nov 21.0 h");
  await expect(hourRows.first()).toHaveText("Aug 240.0 h");
  await expect(flights.locator("tbody tr").last()).toHaveText("Nov 92");

  // The charts follow the aircraft filter: N208MA flew only the 2.0 h leg.
  await page
    .getByLabel("Aircraft", { exact: true })
    .selectOption({ label: "N208MA" });
  await expect(hourRows.last()).toHaveText("Nov 92.0 h");
  await expect(flights.locator("tbody tr").last()).toHaveText("Nov 91");

  await page
    .getByRole("searchbox", { name: "Search flights" })
    .fill("no flight matches this");
  await expect(hours).toHaveCount(0);
  await expect(flights).toHaveCount(0);
});

test("a phone lists the flights without the charts", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await demo(page);
  await storeFlights(page);
  await page.goto("/flights");
  await expect(page.locator(".rec-flight-card")).toHaveCount(3);
  await expect(page.getByRole("figure")).toHaveCount(0);
});

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
 * Stores three flights in every snapshot on the device, at local noon so
 * the week does not depend on the time zone: 1.0 h on N206MA on 3 Nov 2026,
 * 1.5 h on N206MA on 10 Nov and 2.0 h on N208MA on 11 Nov.
 */
async function storeFlights(page: Page) {
  await page.evaluate(async (hour) => {
    const legs = [
      { day: 3, aircraftUuid: "demo-206", hours: 1 },
      { day: 10, aircraftUuid: "demo-206", hours: 1.5 },
      { day: 11, aircraftUuid: "demo-208", hours: 2 },
    ];
    const flights = legs.map((leg, i) => ({
      uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      aircraftUuid: leg.aircraftUuid,
      authorId: "demo-admin",
      pilotId: "demo-admin",
      submittedAt: new Date(2026, 10, leg.day, 12).getTime(),
      status: "accepted",
      startTime: new Date(2026, 10, leg.day, 12).toISOString(),
      hobbsOff: 100 * hour,
      hobbsOn: (100 + leg.hours) * hour,
      landings: 1,
      cycles: 0,
      origin: "KSEA",
      destination: "KBFI",
      operation: "Mission",
      flightRules: "VFR",
      remarks: "",
      discrepancy: "",
    }));
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
  }, HOUR_SECONDS);
  await page.reload();
}
