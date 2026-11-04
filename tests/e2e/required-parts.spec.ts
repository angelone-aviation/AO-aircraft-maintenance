/**
 * Responsibility: Pins required parts across features: an inspection's and an
 *   AD's recurring parts lists, their work-order occurrences, and the parts
 *   shortage on the maintenance outlook.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures (requiredParts, workOrders),
 *   src/domain (workOrders, airworthiness, model types).
 */
import { test, expect, type Page } from "@playwright/test";
import { partsFixture, neededPart } from "../fixtures/requiredParts";
import { workOrderCommand } from "../fixtures/workOrders";
import { newWorkTask, saveWorkOrder } from "../../src/domain/workOrders";
import { blankAD, blankADTask } from "../../src/domain/airworthiness";
import type { Snapshot } from "../../src/domain/model";

const HOUR_SECONDS = 3600;

test("unifies saved required parts with recurring requests, work-order occurrences and maintenance forecasts", async ({
  page,
}) => {
  const fixture = recurringPartsFixture();
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspections");
  await expect(
    page.getByRole("heading", { name: "Inspections", exact: true }),
  ).toBeVisible();
  await storeFixture(page, fixture);
  await page.reload();
  const row = page
    .getByRole("row")
    .filter({ hasText: "100-hour inspection" })
    .filter({ hasText: "N206MA" });
  await row
    .getByRole("button", { name: "Parts / repair requests", exact: true })
    .click();
  // Dialogs stack; the last is on top.
  const dialog = page.getByRole("dialog").last();
  await dialog
    .getByRole("button", { name: "New request", exact: true })
    .click();
  await expect(dialog.getByLabel("Part number", { exact: true })).toHaveValue(
    "FILTER-1",
  );
  await expect(
    dialog.getByRole("checkbox", { name: /Recurring —/ }),
  ).toBeChecked();
  await dialog
    .getByRole("button", { name: "Save request", exact: true })
    .click();
  // The recurring list (PR-00001) also creates one occurrence (PR-00002) for
  // the open work-order task; only an occurrence can be ordered.
  await expect(
    dialog.getByRole("button", { name: "PR-00001", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "PR-00002", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "Select PR-00001", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "PR-00002", exact: true }).click();
  await expect(dialog.getByText(/Recurring occurrence/)).toBeVisible();
  await expect(dialog.getByLabel("Stock lot / location")).toBeVisible();
  await page.goto("/");
  await expect(
    page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Maintenance outlook",
        exact: true,
      }),
    }),
  ).toContainText("Parts shortage");
  await page.goto("/airworthiness");
  await page.locator(".ad-register-group > summary").first().click();
  await page
    .getByRole("button", { name: "View AD 2026-01-01", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Parts / repair requests", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "New request", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: /Recurring —/ }).check();
  await dialog.getByLabel("Part number", { exact: true }).fill("FILTER-1");
  await dialog.getByLabel("Part name", { exact: true }).fill("Filter");
  await dialog
    .getByRole("button", { name: "Save request", exact: true })
    .click();
  await expect(dialog).toContainText("Recurring · AD 2026-01-01");
  // The AD's list is PR-00003; PR-00004 is its work-order occurrence.
  await expect(
    page.getByRole("button", { name: "PR-00004", exact: true }),
  ).toBeVisible();
});

/**
 * The parts fixture with FILTER-1 required by N206MA's 100-hour inspection,
 * a recurring AD task, and an open work order performing both.
 */
function recurringPartsFixture(): Snapshot {
  const fixture = partsFixture();
  const inspection = fixture.inspections[0];
  inspection.requiredParts = [neededPart];
  // Due at 2,350 hours, within ten of N206MA's 2,341.2: due soon, so the
  // outlook forecasts its parts.
  inspection.intervalSeconds = 100 * HOUR_SECONDS;
  inspection.lastSeconds = 2250 * HOUR_SECONDS;
  const ad = blankAD(inspection.aircraftUuid);
  ad.source.number = "2026-01-01";
  ad.applicability = "Applicable";
  ad.reviewRequired = false;
  ad.tasks = [
    {
      ...blankADTask(),
      description: "Inspect filter housing",
      recurrence: "Recurring",
      intervalHours: 100,
    },
  ];
  fixture.airworthiness = [ad];
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: inspection.uuid },
      inspection.reference,
    ),
    newWorkTask(
      { kind: "airworthiness", uuid: ad.tasks[0].uuid },
      "Inspect filter housing",
    ),
  ];
  saveWorkOrder(fixture, command);
  return fixture;
}

/**
 * Puts the fixture's stock, inspections, work orders and ADs into every
 * snapshot on the device, with no parts requests or purchase orders.
 */
async function storeFixture(page: Page, fixture: Snapshot) {
  const records = {
    management: fixture.management,
    inspections: fixture.inspections,
    workOrders: fixture.workOrders,
    airworthiness: fixture.airworthiness,
    partsRequests: [],
    purchaseOrders: [],
  };
  await page.evaluate(async (fields) => {
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
      Object.assign(s, fields);
      // The stored parts view is derived from management; dropping it makes
      // the app rebuild it from the seeded records.
      delete s.partsInventory;
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
}
