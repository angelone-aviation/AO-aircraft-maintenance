import { test, expect } from "@playwright/test";
import { partsFixture, neededPart } from "../fixtures/requiredParts";
import { workOrderCommand } from "../fixtures/workOrders";
import { newWorkTask, saveWorkOrder } from "../../src/domain/workOrders";
import { blankAD, blankADTask } from "../../src/domain/airworthiness";

test("unifies saved required parts with recurring requests, work-order occurrences and maintenance forecasts", async ({
  page,
}) => {
  const fixture = partsFixture();
  const inspection = fixture.inspections[0];
  inspection.requiredParts = [neededPart];
  inspection.intervalSeconds = 100 * 3600;
  inspection.lastSeconds = 2250 * 3600;
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
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspections");
  await expect(
    page.getByRole("heading", { name: "Inspections", exact: true }),
  ).toBeVisible();
  await page.evaluate(async (fixture) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          Object.assign(s, {
            management: fixture.management,
            inspections: fixture.inspections,
            workOrders: fixture.workOrders,
            airworthiness: fixture.airworthiness,
            partsRequests: [],
            purchaseOrders: [],
          });
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
  await page.reload();
  const row = page
    .getByRole("row")
    .filter({ hasText: "100-hour inspection" })
    .filter({ hasText: "N206MA" });
  await row
    .getByRole("button", { name: "Parts / repair requests", exact: true })
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
  await expect(
    dialog.getByRole("checkbox", { name: /Recurring —/ }),
  ).toBeChecked();
  await dialog
    .getByRole("button", { name: "Save request", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
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
  dialog = page.getByRole("dialog").last();
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
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "New request", exact: true })
    .click();
  dialog = page.getByRole("dialog").last();
  await dialog.getByRole("checkbox", { name: /Recurring —/ }).check();
  await dialog.getByLabel("Part number", { exact: true }).fill("FILTER-1");
  await dialog.getByLabel("Part name", { exact: true }).fill("Filter");
  await dialog
    .getByRole("button", { name: "Save request", exact: true })
    .click();
  await expect(page.getByRole("dialog").last()).toContainText(
    "Recurring · AD 2026-01-01",
  );
  await expect(
    page.getByRole("button", { name: "PR-00004", exact: true }),
  ).toBeVisible();
});
