/**
 * Responsibility: Pins parts and repair requests: an inspection's request
 *   reserving stock, ordering the shortage, receiving and issuing it; and a
 *   repair request's shipping documents, shipment and component return.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures (requiredParts,
 *   savedAddress), src/domain (model, requiredParts types).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { addSavedAddress } from "../fixtures/savedAddress";
import { partsFixture } from "../fixtures/requiredParts";
import type { Snapshot } from "../../src/domain/model";
import type { RequiredPart } from "../../src/domain/requiredParts";

const REPAIR_RECORDS: Snapshot["management"] = [
  {
    uuid: "store",
    version: 1,
    programUuid: "demo-program",
    kind: "location",
    name: "Main store",
    address: "Main hangar",
    contact: "",
  },
  {
    uuid: "pump",
    version: 1,
    programUuid: "demo-program",
    kind: "component",
    aircraftUuid: "",
    componentType: "Appliance",
    partNumber: "PUMP-1",
    serial: "SN-REPAIR",
    manufacturer: "Maker",
    model: "Pump",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: false,
    locationUuid: "store",
    installedSeconds: 0,
    installedCycles: 0,
    // Stored in seconds: 100 hours since new, 50 since overhaul, 10 since
    // repair.
    timeSinceNew: 360000,
    timeSinceOverhaul: 180000,
    timeSinceRepair: 36000,
    cyclesSinceNew: 100,
    serviceDaysBase: 0,
  },
];

test("inspection request reserves stock, orders the shortage, receives and issues it", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/parts-requests");
  await expect(
    page.getByRole("heading", { name: "Parts & repair requests", exact: true }),
  ).toBeVisible();
  await storeRequestRecords(page, partsFixture().management, [
    { locationUuid: "parts-location", stockUuid: "parts-stock", quantity: 5 },
  ]);
  await page.goto("/inspections");
  await page.reload();
  await page
    .getByRole("button", { name: "Parts / repair requests", exact: true })
    .first()
    .click();
  // Dialogs stack: the last is on top, the first is a purchase order's detail.
  const dialog = page.getByRole("dialog").last();
  const order = page.getByRole("dialog").first();
  await dialog
    .getByRole("button", { name: "New request", exact: true })
    .click();
  await expect(dialog.getByLabel("Part number", { exact: true })).toHaveValue(
    "FILTER-1",
  );
  await expect(dialog.getByLabel("Quantity", { exact: true })).toHaveValue("5");
  if (await dialog.getByRole("checkbox", { name: /Recurring —/ }).count())
    await dialog.getByRole("checkbox", { name: /Recurring —/ }).uncheck();
  await dialog.getByLabel("Preferred vendor").fill("Request Vendor");
  await addSavedAddress(
    page,
    dialog,
    "Deliver / return to",
    "Main receiving",
    "Main hangar",
  );
  await dialog
    .getByRole("button", { name: "Save request", exact: true })
    .click();
  await page.getByRole("button", { name: "PR-00001", exact: true }).click();
  await dialog.getByLabel("Stock lot / location").selectOption("parts-stock");
  await dialog.getByLabel("Quantity", { exact: true }).fill("2");
  await dialog
    .getByRole("button", { name: "Reserve stock", exact: true })
    .click();
  // 5 needed, 2 reserved from stock: the other 3 are to order.
  await expect(
    dialog.getByText(
      "Reserved 2 · Issued 0 · On POs 0 · Received 0 · To order 3",
    ),
  ).toBeVisible();
  const pdf = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download parts request" }).click();
  expect((await pdf).suggestedFilename()).toBe("PR-00001.pdf");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await addRequestToOrder(dialog);
  await expect(
    dialog.getByLabel("Part 1 quantity", { exact: true }),
  ).toHaveValue("3");
  await saveDraftOrder(page, dialog);
  await openPurchaseOrder(page, "Request Vendor");
  await issuePurchaseOrder(dialog, order);
  await order
    .getByRole("button", { name: "Receive parts", exact: true })
    .click();
  await dialog.getByLabel("FILTER-1 quantity received").fill("3");
  await dialog
    .getByRole("button", {
      name: "Confirm receipt into inventory",
      exact: true,
    })
    .click();
  await expect(order.getByRole("heading").first()).toContainText("Received");
  await page.goto("/parts-requests");
  await page.getByRole("button", { name: "PR-00001", exact: true }).click();
  // Received parts are reserved for the request that ordered them.
  await expect(
    dialog.getByText(
      "Reserved 5 · Issued 0 · On POs 3 · Received 3 · To order 0",
    ),
  ).toBeVisible();
  await dialog.getByLabel("Inventory action").selectOption("issue");
  await dialog.getByLabel("Stock lot / location").selectOption("parts-stock");
  await dialog.getByLabel("Quantity", { exact: true }).fill("5");
  await dialog
    .getByRole("button", { name: "Issue reserved parts", exact: true })
    .click();
  await expect(dialog.getByRole("heading").first()).toHaveText(
    "PR-00001 · Fulfilled",
  );
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: "PR-00001" }),
  ).toContainText("Fulfilled");
});

test("repair request produces shipping documents and returns the original component", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inventory");
  await expect(
    page.getByRole("heading", { name: "Inventory", exact: true }),
  ).toBeVisible();
  await storeRequestRecords(page, REPAIR_RECORDS);
  await page.reload();
  await page
    .getByRole("row")
    .filter({ hasText: "SN-REPAIR" })
    .getByRole("button", { name: "Parts / repair requests", exact: true })
    .click();
  // Dialogs stack: the last is on top, the first is a purchase order's detail.
  const dialog = page.getByRole("dialog").last();
  const order = page.getByRole("dialog").first();
  await dialog
    .getByRole("button", { name: "New request", exact: true })
    .click();
  await expect(dialog.getByLabel("Request type")).toHaveValue("repair");
  await expect(dialog.getByLabel("Part number", { exact: true })).toHaveValue(
    "PUMP-1",
  );
  await dialog.getByLabel("Preferred vendor").fill("Repair Vendor");
  await dialog
    .getByLabel("Defect", { exact: true })
    .fill("Pump leaking at seal");
  await dialog
    .getByLabel("Work requested", { exact: true })
    .fill("Replace seal and bench test");
  await addSavedAddress(
    page,
    dialog,
    "Ship from",
    "Shipping hangar",
    "Main hangar",
  );
  await addSavedAddress(
    page,
    dialog,
    "Bill to",
    "Billing office",
    "Flight Program",
  );
  await dialog
    .getByRole("button", { name: "Save request", exact: true })
    .click();
  await addRequestToOrder(dialog);
  await expect(dialog.getByLabel("Add to existing draft PO")).toBeVisible();
  await saveDraftOrder(page, dialog);
  await openPurchaseOrder(page, "Repair Vendor");
  for (const name of [
    "Repair order / tag PR-00001",
    "Packing slip PR-00001",
    "Save PO PDF",
  ]) {
    const download = page.waitForEvent("download");
    await order.getByRole("button", { name, exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  }
  await issuePurchaseOrder(dialog, order);
  await order
    .getByRole("button", { name: "Record shipment", exact: true })
    .click();
  await dialog.getByLabel("PUMP-1 quantity shipped").fill("1");
  await dialog.getByLabel("Carrier", { exact: true }).fill("Courier");
  await dialog.getByLabel("Tracking number").fill("TRACK-REPAIR");
  await dialog
    .getByRole("button", { name: "Save shipment", exact: true })
    .click();
  await expect(order).toContainText("TRACK-REPAIR");
  await page.goto("/inventory");
  await expect(
    page.getByRole("row").filter({ hasText: "SN-REPAIR" }),
  ).toContainText("Out for repair");
  await openPurchaseOrder(page, "Repair Vendor");
  await order
    .getByRole("button", { name: "Receive repair return", exact: true })
    .click();
  await dialog.getByLabel("PUMP-1 quantity received").fill("1");
  await expect(dialog.getByLabel("PUMP-1 item 1 serial number")).toHaveValue(
    "SN-REPAIR",
  );
  await dialog.getByLabel("PUMP-1 item 1 time since new (hours)").fill("101");
  await dialog.getByLabel("PUMP-1 item 1 cycles since new").fill("101");
  await dialog
    .getByLabel("PUMP-1 received condition")
    .selectOption("overhauled");
  await dialog
    .getByRole("button", {
      name: "Confirm receipt into inventory",
      exact: true,
    })
    .click();
  await expect(order.getByRole("heading").first()).toContainText("Received");
  // The same component comes back into storage; no second record is made.
  await page.goto("/inventory");
  const row = page.getByRole("row").filter({ hasText: "SN-REPAIR" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("In storage");
  await page.goto("/parts-requests");
  await expect(
    page.getByRole("row").filter({ hasText: "PR-00001" }),
  ).toContainText("Fulfilled");
});

/**
 * Replaces the management records and clears parts requests and purchase
 * orders in every snapshot on the device; `requiredParts`, when given, goes
 * on the first inspection.
 */
async function storeRequestRecords(
  page: Page,
  management: Snapshot["management"],
  requiredParts?: RequiredPart[],
) {
  await page.evaluate(
    async (records) => {
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
        s.management = records.management;
        s.partsRequests = [];
        s.purchaseOrders = [];
        if (records.requiredParts)
          s.inspections[0].requiredParts = records.requiredParts;
        // The stored parts view is derived from management; dropping it
        // makes the app rebuild it from the seeded records.
        delete s.partsInventory;
        entry.update(s);
        entry.continue();
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { management, requiredParts },
  );
}

/** Selects PR-00001 in the open request list and starts a purchase order. */
async function addRequestToOrder(dialog: Locator) {
  await dialog.getByLabel("Select PR-00001").check();
  await dialog
    .getByRole("button", { name: "Add selected to purchase order (1)" })
    .click();
}

async function saveDraftOrder(page: Page, dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Save draft PO", exact: true })
    .click();
  // Wait for the draft PO save to finish before leaving the page.
  await expect(
    page.getByRole("button", { name: "Save draft PO", exact: true }),
  ).toHaveCount(0);
}

async function openPurchaseOrder(page: Page, vendor: string) {
  await page.goto("/purchase-orders");
  await page
    .getByRole("row")
    .filter({ hasText: vendor })
    .getByRole("button")
    .click();
}

async function issuePurchaseOrder(dialog: Locator, order: Locator) {
  await order.getByRole("button", { name: "Issue PO", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Finalize PO", exact: true })
    .click();
}
