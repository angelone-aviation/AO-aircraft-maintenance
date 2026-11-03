import { addSavedAddress } from "../fixtures/savedAddress";
import { test, expect } from "@playwright/test";
import { partsFixture } from "../fixtures/requiredParts";
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
  const fixture = partsFixture();
  await page.evaluate(async (fixture) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.management = fixture.management;
          s.partsRequests = [];
          s.purchaseOrders = [];
          s.inspections[0].requiredParts = [
            {
              locationUuid: "parts-location",
              stockUuid: "parts-stock",
              quantity: 5,
            },
          ];
          delete s.partsInventory;
          entry.update(s);
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, fixture);
  await page.goto("/inspections");
  await page.reload();
  await page
    .getByRole("button", { name: "Parts / repair requests", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "New request", exact: true })
    .click();
  let dialog = page.getByRole("dialog").last();
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
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Stock lot / location").selectOption("parts-stock");
  await dialog.getByLabel("Quantity", { exact: true }).fill("2");
  await dialog
    .getByRole("button", { name: "Reserve stock", exact: true })
    .click();
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
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Select PR-00001").check();
  await dialog
    .getByRole("button", { name: "Add selected to purchase order (1)" })
    .click();
  dialog = page.getByRole("dialog").last();
  await expect(
    dialog.getByLabel("Part 1 quantity", { exact: true }),
  ).toHaveValue("3");
  await dialog
    .getByRole("button", { name: "Save draft PO", exact: true })
    .click();
  // Wait for the draft PO save to finish before leaving the page.
  await expect(
    page.getByRole("button", { name: "Save draft PO", exact: true }),
  ).toHaveCount(0);
  await page.goto("/purchase-orders");
  await page
    .getByRole("row")
    .filter({ hasText: "Request Vendor" })
    .getByRole("button")
    .click();
  let detail = page.getByRole("dialog").first();
  await detail.getByRole("button", { name: "Issue PO", exact: true }).click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Finalize PO", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Receive parts", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("FILTER-1 quantity received").fill("3");
  await dialog
    .getByRole("button", {
      name: "Confirm receipt into inventory",
      exact: true,
    })
    .click();
  await expect(detail.getByRole("heading").first()).toContainText("Received");
  await page.goto("/parts-requests");
  await page.getByRole("button", { name: "PR-00001", exact: true }).click();
  detail = page.getByRole("dialog").last();
  await expect(
    detail.getByText(
      "Reserved 5 · Issued 0 · On POs 3 · Received 3 · To order 0",
    ),
  ).toBeVisible();
  await detail.getByLabel("Inventory action").selectOption("issue");
  await detail.getByLabel("Stock lot / location").selectOption("parts-stock");
  await detail.getByLabel("Quantity", { exact: true }).fill("5");
  await detail
    .getByRole("button", { name: "Issue reserved parts", exact: true })
    .click();
  await expect(detail.getByRole("heading").first()).toHaveText(
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
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.management = [
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
              timeSinceNew: 360000,
              timeSinceOverhaul: 180000,
              timeSinceRepair: 36000,
              cyclesSinceNew: 100,
              serviceDaysBase: 0,
            },
          ];
          s.partsRequests = [];
          s.purchaseOrders = [];
          delete s.partsInventory;
          entry.update(s);
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await page
    .getByRole("row")
    .filter({ hasText: "SN-REPAIR" })
    .getByRole("button", { name: "Parts / repair requests", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "New request", exact: true })
    .click();
  let dialog = page.getByRole("dialog").last();
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
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Select PR-00001").check();
  await dialog
    .getByRole("button", { name: "Add selected to purchase order (1)" })
    .click();
  dialog = page.getByRole("dialog").last();
  await expect(dialog.getByLabel("Add to existing draft PO")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save draft PO", exact: true })
    .click();
  // Wait for the draft PO save to finish before leaving the page.
  await expect(
    page.getByRole("button", { name: "Save draft PO", exact: true }),
  ).toHaveCount(0);
  await page.goto("/purchase-orders");
  await page
    .getByRole("row")
    .filter({ hasText: "Repair Vendor" })
    .getByRole("button")
    .click();
  let detail = page.getByRole("dialog").first();
  for (const name of [
    "Repair order / tag PR-00001",
    "Packing slip PR-00001",
    "Save PO PDF",
  ]) {
    const download = page.waitForEvent("download");
    await detail.getByRole("button", { name, exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  }
  await detail.getByRole("button", { name: "Issue PO", exact: true }).click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Finalize PO", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Record shipment", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("PUMP-1 quantity shipped").fill("1");
  await dialog.getByLabel("Carrier", { exact: true }).fill("Courier");
  await dialog.getByLabel("Tracking number").fill("TRACK-REPAIR");
  await dialog
    .getByRole("button", { name: "Save shipment", exact: true })
    .click();
  await expect(detail).toContainText("TRACK-REPAIR");
  await page.goto("/inventory");
  await expect(
    page.getByRole("row").filter({ hasText: "SN-REPAIR" }),
  ).toContainText("Out for repair");
  await page.goto("/purchase-orders");
  await page
    .getByRole("row")
    .filter({ hasText: "Repair Vendor" })
    .getByRole("button")
    .click();
  detail = page.getByRole("dialog").first();
  await detail
    .getByRole("button", { name: "Receive repair return", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
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
  await expect(detail.getByRole("heading").first()).toContainText("Received");
  await page.goto("/inventory");
  const row = page.getByRole("row").filter({ hasText: "SN-REPAIR" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("In storage");
  await page.goto("/parts-requests");
  await expect(
    page.getByRole("row").filter({ hasText: "PR-00001" }),
  ).toContainText("Fulfilled");
});
