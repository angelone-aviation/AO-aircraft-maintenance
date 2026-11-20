/**
 * Responsibility: Pins Load older on the Flight log, Discrepancies and Work
 *   orders with aged demo records: older rows load only through it, filters
 *   reach the server, a write of the kind reloads the pages, offline it
 *   needs a connection, an older record's job card and photo work, the
 *   records package pages full history in, a plan flown long ago and a job
 *   card's older report load on demand, and the windowed copy on the device
 *   is enough to log a flight offline.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, fflate, node:fs, node:path, src/domain
 *   (workOrders, taskCards, flightPlans).
 *
 * The demo's records are dated now, so each test stores records older than
 * the retention window, which the demo's workspace then leaves to Load
 * older, as a live program's does.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { newWorkTask, workOrderSchema } from "../../src/domain/workOrders";
import { taskCardDefaults, taskCardSchema } from "../../src/domain/taskCards";
import { flightPlanSchema } from "../../src/domain/flightPlans";

const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3600;
// Older than both windows: six months of flights, three of maintenance.
const AGE_DAYS = 400;
const PHOTO = path.resolve("public/icon-192.png");
const N206 = "demo-206";
const N208 = "demo-208";

test("the Flight log loads older flights, filtered by aircraft on the server", async ({
  page,
  context,
}) => {
  await openDemo(page, "/flights");
  await storeOlderRecords(page, { flights: olderFlights() });
  const pager = historyPager(page);
  await expect(pager).toContainText("Showing the last 6 months");
  await expect(flightRow(page, "KOLA")).toHaveCount(0);
  await pager.getByRole("button", { name: "Load older" }).click();
  await expect(flightRow(page, "KOLA")).toBeVisible();
  await expect(flightRow(page, "KOLB")).toBeVisible();
  await expect(pager).toContainText("and 2 older flights");
  await expect(pager).toContainText("All records loaded");

  await page
    .getByLabel("Aircraft", { exact: true })
    .selectOption({ label: "N208MA" });
  await expect(flightRow(page, "KOLB")).toHaveCount(0);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(flightRow(page, "KOLB")).toBeVisible();
  await expect(flightRow(page, "KOLA")).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search flights" }).fill("KOL");
  await expect(
    page.getByText("Search covers the flights loaded here"),
  ).toBeVisible();

  const row = flightRow(page, "KOLB");
  await row.locator("input[type=file]").setInputFiles(PHOTO);
  await expect(
    row.getByRole("button", { name: "Open logbook photo icon-192.png" }),
  ).toBeVisible();

  await context.setOffline(true);
  await page
    .getByLabel("Aircraft", { exact: true })
    .selectOption({ label: "N206MA" });
  const offline = historyPager(page);
  await expect(
    offline.getByRole("button", { name: "Load older" }),
  ).toBeDisabled();
  await expect(offline).toContainText("Older records need a connection");
});

test("Discrepancies load older reports under All and reload them after a write", async ({
  page,
}) => {
  await openDemo(page, "/discrepancies");
  await storeOlderRecords(page, { discrepancies: [olderReport()] });
  await page.getByRole("button", { name: "All", exact: true }).click();
  const pager = historyPager(page);
  await expect(pager).toContainText(/\d+ reports? in the last 3 months/);
  await expect(page.getByText("OLD-REPORT")).toHaveCount(0);
  await pager.getByRole("button", { name: "Load older" }).click();
  const old = page.getByRole("article").filter({ hasText: "OLD-REPORT" });
  await expect(old).toContainText("Replaced the bulb");
  await expect(pager).toContainText("and 1 older");

  // Pages are not reactive: a change stored on the server shows only after
  // a write of problem reports reloads them.
  await editStoredReport(page, "Replaced the bulb and the socket");
  await expect(old).not.toContainText("and the socket");
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page.getByLabel("What did you observe?").fill("Cabin light dim");
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(old).toContainText("Replaced the bulb and the socket");
});

test("Work orders load older closed orders, whose archived job cards open", async ({
  page,
}) => {
  await openDemo(page, "/work-orders");
  const older = olderWorkOrder();
  await storeOlderRecords(page, {
    workOrders: [...recentWorkOrders(), older.order],
    archivedTaskCards: [older.card],
  });
  await expect(historyPager(page)).toHaveCount(0);
  await page.getByLabel("Include closed work orders").check();
  const pager = historyPager(page);
  await expect(pager).toContainText("Showing the last 3 months");
  await expect(orderRow(page, "WO-OLD-0001")).toHaveCount(0);
  await pager.getByRole("button", { name: "Load older" }).click();
  const row = orderRow(page, "WO-OLD-0001");
  await expect(row).toBeVisible();
  await expect(pager).toContainText("and 1 older work order");

  await row.getByRole("button", { name: "Details", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Replace landing light", { exact: true }).click();
  await dialog
    .getByRole("button", { name: "TC-OLD-1 · Landing light card" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Job card TC-OLD-1" }),
  ).toBeVisible();
});

test("the records package pages older flights in, and says it is partial offline (H4)", async ({
  page,
  context,
}) => {
  await openDemo(page, "/");
  await storeOlderRecords(page, { flights: olderFlights() });
  const connected = await exportPackage(page);
  expect(connected).toContain("KOLA");
  expect(connected).not.toContain("Partial flights");
  await page.keyboard.press("Escape");
  await context.setOffline(true);
  const offline = await exportPackage(page);
  expect(offline).not.toContain("KOLA");
  expect(offline).toMatch(/^"Partial flights: only the last 6 months/m);
});

test("a pilot logs a flight offline from the windowed copy, with plans, crew and open reports", async ({
  page,
  context,
}) => {
  await openDemo(page, "/flight-plans");
  await page
    .getByLabel("Upload Flight Plan PDF")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  const upload = page.getByRole("dialog");
  await upload.getByLabel("Aircraft", { exact: true }).selectOption(N206);
  await upload
    .getByLabel("Aircraft differs from the PDF: confirm reassignment")
    .check();
  await upload.getByRole("button", { name: "Save flight plan" }).click();
  await expect(upload).not.toBeVisible();
  await storeOlderRecords(page, {
    flights: olderFlights(),
    discrepancies: [olderReport()],
  });

  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Start / resume flight" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await expect(page.getByRole("article").first()).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText("OLD-REPORT")).toHaveCount(0);
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(flightRow(page, "KOLA")).toHaveCount(0);

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByLabel("Pilot", { exact: true })).toContainText(
    "Jordan Lee",
  );
  await form.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
  await form.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(
    page.getByText("1 entry waiting to send · Offline"),
  ).toBeVisible();

  await context.setOffline(false);
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await historyPager(page).getByRole("button", { name: "Load older" }).click();
  await expect(flightRow(page, "KOLA")).toBeVisible();
});

test("a plan flown long ago leaves the queue and says Logged once its flight loads", async ({
  page,
  context,
}) => {
  await openDemo(page, "/flight-plans");
  const plan = olderPlan();
  const [flight] = olderFlights();
  await storeOlderRecords(page, {
    flightPlans: [plan],
    flights: [{ ...flight, flightPlanUuid: plan.uuid }],
  });
  const history = page.locator(".ops-plan-history");
  await history.getByText(/Logged and removed plans/).click();
  await expect(history).toContainText("KOLD → KBFI · Logged");
  await expect(
    page.getByRole("button", { name: "Start / resume flight" }),
  ).toHaveCount(0);

  await context.setOffline(true);
  await page.reload();
  await page
    .locator(".ops-plan-history")
    .getByText(/Logged and removed/)
    .click();
  await expect(page.locator(".ops-plan-history")).toContainText(
    "whether it flew needs a connection",
  );
});

test("a job card names the older problem report it links to", async ({
  page,
}) => {
  await openDemo(page, "/task-cards");
  const report = olderReport();
  const card = taskCardSchema.parse({
    ...taskCardDefaults(N206),
    uuid: crypto.randomUUID(),
    version: 1,
    cardNumber: "TC-LINKED",
    title: "Landing light follow-up",
    discrepancyUuid: report.uuid,
    status: "ready",
    createdAt: daysAgo(1),
    createdBy: "demo-admin",
    updatedAt: daysAgo(1),
    stepSignoffs: {},
    technicianSignoff: null,
    inspectionSignoff: null,
  });
  await storeOlderRecords(page, { discrepancies: [report], taskCards: [card] });
  await page
    .getByRole("row")
    .filter({ hasText: "TC-LINKED" })
    .getByRole("button", { name: "Details for TC-LINKED", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Job card TC-LINKED" });
  await expect(
    editor.getByLabel("Originating discrepancy", { exact: true }),
  ).toContainText("OLD-REPORT");
});

/** Opens the demo. */
async function openDemo(page: Page, route: string) {
  await page.addInitScript(() => {
    sessionStorage.setItem("angel-one-demo", "true");
  });
  await page.goto(route);
  await expect(page.getByRole("main")).toBeVisible();
}

/**
 * Adds records to every stored demo snapshot, then reloads: the demo rebuilds
 * its workspace from the full one through the window, so older records are
 * left to the history pages.
 */
async function storeOlderRecords(
  page: Page,
  records: Record<string, unknown[]>,
) {
  await page.evaluate(async (added) => {
    // The reload below is then under the service worker, which keeps the
    // PDF font and library for an export made offline.
    await navigator.serviceWorker.ready;
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
      const s = entry.value;
      for (const [name, rows] of Object.entries(added))
        s[name] = [...(s[name] ?? []), ...rows];
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
  await page.reload();
}

// Changes the older report's resolution in the stored copy only, as another
// device's change would reach the server without reaching this tab.
async function editStoredReport(page: Page, resolution: string) {
  await page.evaluate(async (text) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    const read = store.get("demo:all");
    read.onsuccess = () => {
      const s = read.result;
      for (const d of s.discrepancies)
        if (d.description === "OLD-REPORT") d.resolution = text;
      store.put(s, "demo:all");
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, resolution);
}

// Exports N206MA's records package and returns its flights.csv.
async function exportPackage(page: Page): Promise<string> {
  await page
    .getByRole("article")
    .filter({ hasText: "N206MA" })
    .getByRole("button", { name: /View aircraft/i })
    .click();
  const detail = page.getByRole("dialog", { name: "N206MA" });
  const downloading = page.waitForEvent("download");
  await detail
    .getByRole("button", { name: "Export records package", exact: true })
    .click();
  const file = await (await downloading).path();
  const files = unzipSync(new Uint8Array(await readFile(file)));
  return strFromU8(files["flights.csv"]);
}

function historyPager(page: Page): Locator {
  return page.locator(".history-pager");
}

function flightRow(page: Page, origin: string): Locator {
  return page.getByRole("row").filter({ hasText: origin });
}

function orderRow(page: Page, number: string): Locator {
  return page.getByRole("row").filter({ hasText: number });
}

function daysAgo(days: number): number {
  return Date.now() - days * DAY_MS;
}

function olderFlights() {
  return [
    { origin: "KOLA", aircraftUuid: N206, age: AGE_DAYS },
    { origin: "KOLB", aircraftUuid: N208, age: AGE_DAYS + 10 },
  ].map(({ origin, aircraftUuid, age }) => ({
    uuid: crypto.randomUUID(),
    aircraftUuid,
    authorId: "demo-admin",
    pilotId: "demo-admin",
    submittedAt: daysAgo(age),
    status: "accepted",
    startTime: new Date(daysAgo(age)).toISOString(),
    hobbsOff: 100 * HOUR_SECONDS,
    hobbsOn: 101 * HOUR_SECONDS,
    landings: 1,
    cycles: 0,
    origin,
    destination: "KBFI",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  }));
}

function olderReport() {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: N206,
    description: "OLD-REPORT",
    status: "resolved",
    authorId: "demo-admin",
    createdAt: daysAgo(AGE_DAYS),
    resolvedAt: daysAgo(AGE_DAYS - 1),
    resolvedBy: "demo-admin",
    resolution: "Replaced the bulb",
  };
}

// Five orders completed this month, so the older one is not among the
// latest five the window keeps for the owner portal.
function recentWorkOrders() {
  return [1, 2, 3, 4, 5].map((n) =>
    completedOrder(`WO-RECENT-000${n}`, daysAgo(n)),
  );
}

function olderWorkOrder() {
  const order = completedOrder("WO-OLD-0001", daysAgo(AGE_DAYS));
  const card = taskCardSchema.parse({
    ...taskCardDefaults(N206),
    uuid: crypto.randomUUID(),
    version: 1,
    cardNumber: "TC-OLD-1",
    title: "Landing light card",
    workOrderUuid: order.uuid,
    status: "completed",
    createdAt: daysAgo(AGE_DAYS + 5),
    createdBy: "demo-admin",
    updatedAt: daysAgo(AGE_DAYS + 5),
    stepSignoffs: {},
    technicianSignoff: null,
    inspectionSignoff: null,
  });
  const task = newWorkTask(
    { kind: "manual", uuid: crypto.randomUUID() },
    "Replace landing light",
  );
  const archivedTasks = [
    {
      task,
      cardUuids: [card.uuid],
      removedAt: daysAgo(AGE_DAYS + 2),
      removedBy: "demo-admin",
      removedByName: "Demo Admin",
    },
  ];
  return { order: { ...order, archivedTasks }, card };
}

function completedOrder(number: string, completedAt: number) {
  const completionDate = new Date(completedAt).toISOString().slice(0, 10);
  return workOrderSchema.parse({
    uuid: crypto.randomUUID(),
    version: 1,
    number,
    aircraftUuid: N206,
    dateOpened: completionDate,
    supervisor: "Chief inspector",
    scope: "Annual inspection.",
    priority: "routine",
    status: "completed",
    completionDate,
    releaseOutcome: "",
    recordedAt: completedAt,
    createdBy: "demo-admin",
    aircraft: {
      ...{ registration: "N206MA", make: "Cessna", model: "206" },
      ...{ serial: "1", totalSeconds: 0, hobbs: 0, tach: 0 },
      ...{ meter: "hobbs", cycles: 0 },
    },
    componentReadings: [],
    tasks: [],
  });
}

// A plan that departed with the older flights, as the PDF import stores one,
// imported lately: the window keeps a plan filed in its three months (H5).
function olderPlan() {
  return flightPlanSchema.parse({
    uuid: crypto.randomUUID(),
    version: 1,
    aircraftUuid: N206,
    registration: "N206MA",
    departureAt: new Date(daysAgo(AGE_DAYS)).toISOString(),
    origin: "KOLD",
    destination: "KBFI",
    alternate: "",
    durationMinutes: 60,
    cycles: 0,
    landings: 1,
    flightRules: "V",
    aircraftType: "C206",
    flightType: "G",
    speed: "",
    level: "",
    route: "DCT",
    pilotText: "",
    equipment: "",
    otherInformation: "",
    sourceName: "older-plan.pdf",
    sourceHash: "0".repeat(64),
    status: "proposed",
    createdAt: daysAgo(10),
  });
}
