/**
 * Responsibility: Pins Load older on Parts requests, Purchase orders, Flight
 *   plans and a vendor's orders with aged demo records (H5), and an older
 *   request a recent purchase order names, loaded on demand and asked for
 *   again offline.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain (partsRequests, purchaseOrders,
 *   flightPlans).
 *
 * The demo's records are dated now, so each test stores records older than
 * the retention window, which the demo's workspace then leaves to Load
 * older, as a live program's does (ADR-0013).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { partsRequestSchema } from "../../src/domain/partsRequests";
import { poSchema } from "../../src/domain/purchaseOrders";
import { flightPlanSchema } from "../../src/domain/flightPlans";

const DAY_MS = 86_400_000;
// Older than both windows: six months of plans, three of purchasing.
const AGE_DAYS = 400;
const N206 = "demo-206";
const PROGRAM = "demo-program";

test("Parts requests load older settled requests through Load older", async ({
  page,
}) => {
  await openDemo(page, "/parts-requests");
  await storeOlderRecords(page, {
    partsRequests: [settledRequest("PR-OLD-0001")],
  });
  const pager = historyPager(page);
  await expect(pager).toContainText("Showing the last 3 months");
  await expect(row(page, "PR-OLD-0001")).toHaveCount(0);
  await pager.getByRole("button", { name: "Load older" }).click();
  await expect(row(page, "PR-OLD-0001")).toBeVisible();
  await expect(row(page, "PR-OLD-0001")).toContainText("Fulfilled");
  await expect(pager).toContainText("and 1 older request");
  await expect(pager).toContainText("All records loaded");
});

test("Purchase orders load older closed orders, and offline say they need a connection", async ({
  page,
  context,
}) => {
  await openDemo(page, "/purchase-orders");
  await storeOlderRecords(page, {
    purchaseOrders: [closedOrder("PO-OLD-0001", daysAgo(AGE_DAYS - 5))],
  });
  const pager = historyPager(page);
  await expect(pager).toContainText("Showing the last 3 months");
  await expect(row(page, "PO-OLD-0001")).toHaveCount(0);
  await pager.getByRole("button", { name: "Load older" }).click();
  await expect(row(page, "PO-OLD-0001")).toContainText("Closed");
  await expect(pager).toContainText("and 1 older order");

  await context.setOffline(true);
  await page.reload();
  const offline = historyPager(page);
  await expect(
    offline.getByRole("button", { name: "Load older" }),
  ).toBeDisabled();
  await expect(offline).toContainText("Older records need a connection");
});

test("Flight plans load older plans into each aircraft's history", async ({
  page,
}) => {
  await openDemo(page, "/flight-plans");
  await storeOlderRecords(page, { flightPlans: [olderPlan()] });
  const pager = historyPager(page);
  await expect(pager).toContainText("Showing the last 6 months");
  await expect(page.getByText("KOLC → KBFI")).toHaveCount(0);
  await pager.getByRole("button", { name: "Load older" }).click();
  await expect(pager).toContainText("and 1 older plan");
  const history = page
    .locator(".ops-plan-history")
    .filter({ hasText: /Logged and removed plans \(\d+\)/ });
  await history.getByText(/Logged and removed plans/).click();
  await expect(history).toContainText("KOLC → KBFI · Removed");
});

test("a vendor's orders load older ones, and total what the orders listed placed", async ({
  page,
}) => {
  await openDemo(page, "/vendors");
  await storeOlderRecords(page, {
    purchaseOrders: [
      closedOrder("PO-RECENT-0001", daysAgo(5)),
      closedOrder("PO-OLD-0003", daysAgo(AGE_DAYS - 5)),
    ],
  });
  await row(page, "Older Supply Co")
    .getByRole("button", { name: "Orders", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Orders · Older Supply Co" });
  await expect(dialog).toContainText("PO-RECENT-0001");
  await expect(dialog).not.toContainText("PO-OLD-0003");
  await expect(dialog).toContainText("Ordered on the orders listed: USD 12.50");
  await historyPager(page).getByRole("button", { name: "Load older" }).click();
  await expect(dialog).toContainText("PO-OLD-0003");
  await expect(dialog).toContainText("Ordered on the orders listed: USD 25.00");
});

test("a recent order names an older request, which loads on demand", async ({
  page,
  context,
}) => {
  await openDemo(page, "/purchase-orders");
  const request = settledRequest("PR-OLD-0002");
  const order = closedOrder("PO-LATE-0001", daysAgo(5), request);
  await storeOlderRecords(page, {
    partsRequests: [request],
    purchaseOrders: [order],
  });
  const detail = await openOrder(page, "PO-LATE-0001");
  await expect(detail).toContainText("PR-OLD-0002 · Allocated 1");
  await expect(detail.getByRole("button", { name: "Print PO" })).toBeEnabled();

  await page.keyboard.press("Escape");
  await context.setOffline(true);
  await page.reload();
  const offline = await openOrder(page, "PO-LATE-0001");
  await expect(offline).toContainText("Request not loaded · Allocated 1");
  await expect(offline).toContainText("Reconnect to show them");
  await expect(
    offline.getByRole("button", { name: "Print PO" }),
  ).toBeDisabled();
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

async function openOrder(page: Page, number: string): Promise<Locator> {
  await row(page, number).getByRole("button", { name: number }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

function historyPager(page: Page): Locator {
  return page.locator(".history-pager");
}

function row(page: Page, text: string): Locator {
  return page.getByRole("row").filter({ hasText: text });
}

function daysAgo(days: number): number {
  return Date.now() - days * DAY_MS;
}

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// Raised and issued in full over a year ago, so settled and older history.
function settledRequest(number: string) {
  const created = daysAgo(AGE_DAYS);
  const line = crypto.randomUUID();
  return partsRequestSchema.parse({
    uuid: crypto.randomUUID(),
    version: 2,
    source: { kind: "stock", uuid: "", workOrderUuid: "" },
    mode: "parts",
    date: isoDate(created),
    engineer: "Mechanic",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [
      {
        uuid: line,
        partNumber: "OLD-FILTER",
        description: "Oil filter",
        quantity: 1,
      },
    ],
    programUuid: PROGRAM,
    aircraftUuid: N206,
    sourceLabel: "Inventory stock request",
    aircraftRegistration: "N206MA",
    aircraftSerial: "1",
    aircraftModel: "Cessna 206",
    number,
    requesterId: "demo-admin",
    createdAt: created,
    updatedAt: created + DAY_MS,
    cancelled: false,
    reservations: [],
    issues: [
      {
        lineUuid: line,
        stockUuid: crypto.randomUUID(),
        quantity: 1,
        at: created + DAY_MS,
        actorId: "demo-admin",
      },
    ],
    history: [],
  });
}

// Issued over a year ago, received and closed at `closedAt`; its line may
// allocate a request.
function closedOrder(
  number: string,
  closedAt: number,
  request?: ReturnType<typeof settledRequest>,
) {
  const created = daysAgo(AGE_DAYS);
  const line = crypto.randomUUID();
  return poSchema.parse({
    uuid: crypto.randomUUID(),
    version: 3,
    programUuid: PROGRAM,
    number,
    vendor: "Older Supply Co",
    vendorContact: "",
    shipTo: "Hangar 1",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    phase: "closed",
    revision: 0,
    createdAt: created,
    updatedAt: closedAt,
    issuedAt: created,
    lines: [
      {
        uuid: line,
        locationUuid: crypto.randomUUID(),
        partNumber: "OLD-FILTER",
        description: "Oil filter",
        quantity: 1,
        unitCents: 1250,
        kind: "part",
        aircraftUuid: N206,
        ...(request && {
          requestAllocations: [
            {
              requestUuid: request.uuid,
              lineUuid: request.lines[0].uuid,
              quantity: 1,
            },
          ],
        }),
      },
    ],
    shipments: [],
    receipts: [
      {
        uuid: crypto.randomUUID(),
        date: isoDate(closedAt),
        invoice: "INV-OLD",
        notes: "",
        actorId: "demo-admin",
        lines: [
          {
            lineUuid: line,
            quantity: 1,
            condition: "new",
            itemUuids: [],
            serials: [],
          },
        ],
      },
    ],
    history: [],
  });
}

// Filed and departed over a year ago, then removed.
function olderPlan() {
  return flightPlanSchema.parse({
    uuid: crypto.randomUUID(),
    version: 2,
    aircraftUuid: N206,
    registration: "N206MA",
    departureAt: new Date(daysAgo(AGE_DAYS)).toISOString(),
    origin: "KOLC",
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
    sourceHash: "1".repeat(64),
    status: "cancelled",
    createdAt: daysAgo(AGE_DAYS + 1),
  });
}
