/**
 * Responsibility: Pins what happens when two people change the same record:
 *   the stale-save review when the same inspection, AD or work order is
 *   saved from two tabs, Keep mine saving only my changes, and the change
 *   log that keeps both saves; and Edit and retry on a failed entry in the
 *   Sync center.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test; src/domain types (model, airworthiness,
 *   workOrders).
 */
import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/domain/model";
import type { AD } from "../../src/domain/airworthiness";
import type { WorkOrder } from "../../src/domain/workOrders";

const REFERENCE = "TEST-STALE";
const THEIR_DESCRIPTION = "Changed in another tab";
const OVERRIDE_REASON = "Maintenance ferry approved by the director.";
const AD_NUMBER = "2026-01-01";
const WORK_ORDER_NUMBER = "WO-STALE-1";
const PARTS_DELAY = "Awaiting replacement fitting";
const DEFECT = "Left brake pedal soft on rollout";

test("saving an inspection two people changed shows the differences and keeps mine", async ({
  context,
}) => {
  await context.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  const mine = await context.newPage();
  await openDemo(mine);
  await createInspection(mine);
  await openDetails(mine);
  await mine.getByLabel("Repeat every (hours)", { exact: true }).fill("150");

  // The other person saves the same inspection while the form is open.
  const theirs = await context.newPage();
  await openDemo(theirs);
  await openDetails(theirs);
  await theirs
    .getByLabel("Description", { exact: true })
    .fill(THEIR_DESCRIPTION);
  await theirs
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(theirs.getByRole("dialog")).not.toBeVisible();
  await theirs.close();

  await mine
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  const review = mine.getByRole("dialog", {
    name: "Someone else changed this inspection",
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Alex Morgan saved this inspection");
  const description = review.getByRole("row", { name: /Description/ });
  await expect(description).toContainText("Changed by them");
  await expect(description).toContainText("Workshop check");
  await expect(description).toContainText(THEIR_DESCRIPTION);
  await expect(description).toContainText("stays as they saved it");
  const interval = review.getByRole("row", { name: /Repeat every \(hours\)/ });
  await expect(interval).toContainText("Changed by you");
  await expect(interval).toContainText("150.0");
  await expect(interval).toContainText("100.0");
  await review.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(mine.getByRole("dialog")).toHaveCount(0);

  // Only my change was saved: the interval moved the due time, and their
  // description stayed.
  const row = mine.getByRole("row").filter({ hasText: REFERENCE });
  await expect(row).toContainText("2,450.0");
  await expect(row).toContainText(THEIR_DESCRIPTION);
  await mine.getByRole("link", { name: "Change history", exact: true }).click();
  await expect(
    mine.getByText("Inspection details updated.", { exact: true }),
  ).toHaveCount(2);
});

test("keeping an AD edit made while someone recorded compliance keeps the new next due", async ({
  context,
}) => {
  await context.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  const mine = await context.newPage();
  await openDemo(mine);
  await createAD(mine);
  await openADForm(mine);
  const form = mine.getByRole("dialog", { name: "Review AD" });
  await form
    .getByLabel("Subject", { exact: true })
    .fill("Inspect wing attachment fittings");
  const reason = form.getByLabel("Reason for change");
  if (await reason.count()) await reason.fill("Subject wording corrected.");

  const theirs = await context.newPage();
  await openDemo(theirs);
  await recordCompliance(theirs, "2340");
  await theirs.close();

  await form.getByRole("button", { name: "Save AD", exact: true }).click();
  const review = mine.getByRole("dialog", {
    name: "Someone else changed this AD",
  });
  const due = review.getByRole("row", {
    name: /Required action 1 \(Inspect fittings\) · Next due hours/,
  });
  await expect(due).toContainText("Changed by them");
  await expect(due).toContainText("2300");
  await expect(due).toContainText("2440");
  await expect(
    review.getByRole("row", { name: /Compliance history/ }),
  ).toContainText("1 entry; latest");
  await review.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(mine.getByRole("dialog")).toHaveCount(0);
  const stored = await storedAD(mine);
  expect(stored.source.subject).toBe("Inspect wing attachment fittings");
  expect(stored.tasks[0].dueHours).toBe(2440);
  expect(stored.history).toHaveLength(1);
});

test("keeping a work order edit leaves a task's parts delay saved meanwhile", async ({
  context,
}) => {
  await context.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  const mine = await context.newPage();
  await openDemo(mine);
  await createWorkOrder(mine);
  const form = await openWorkOrder(mine);
  await form.getByLabel("Assigned supervisor").fill("Second supervisor");

  const theirs = await context.newPage();
  await openDemo(theirs);
  const other = await openWorkOrder(theirs);
  await other.locator("details.work-order-task-details > summary").click();
  await other.getByLabel("Task 1 status").selectOption("parts-delay");
  await other.getByLabel("Task 1 parts delay").fill(PARTS_DELAY);
  await other
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(other).not.toBeVisible();
  await theirs.close();

  await form
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  const review = mine.getByRole("dialog", {
    name: "Someone else changed this work order",
  });
  const status = review.getByRole("row", {
    name: /Task 1 \(Inspect cabin fittings\) · Status/,
  });
  await expect(status).toContainText("Changed by them");
  await expect(status).toContainText("parts-delay");
  await expect(
    review.getByRole("row", { name: /Task 1 .* · Parts delay/ }),
  ).toContainText(PARTS_DELAY);
  await review.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(review).toHaveCount(0);
  const stored = await storedWorkOrder(mine);
  expect(stored.supervisor).toBe("Second supervisor");
  expect(stored.tasks[0]).toMatchObject({
    status: "parts-delay",
    partsDelay: PARTS_DELAY,
  });
});

test("a failed entry can be edited and retried from the Sync center", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await openDemo(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  // A grounding report queued before the flight grounds the aircraft when
  // it syncs first, so the flight behind it is refused at the dispatch gate.
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Alternator inoperative after start");
  await page.getByRole("checkbox", { name: /Aircraft not airworthy/ }).check();
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await page.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
  await page.getByLabel("Flight date & time").fill("2026-01-01T10:00");
  await page.getByLabel("Discrepancy", { exact: true }).fill(DEFECT);
  await page.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await context.setOffline(false);

  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "1 pending entry" }),
  ).toBeVisible();
  await expect(
    page.locator(".rec-entry").getByText("Needs attention", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/N206MA is grounded/)).toBeVisible();
  await page.getByRole("button", { name: "Edit and retry" }).click();
  const retry = page.getByRole("dialog", { name: "Edit and retry flight" });
  await expect(retry.getByLabel("Ending Hobbs *", { exact: true })).toHaveValue(
    "2342.2",
  );
  await expect(retry.getByLabel("Discrepancy", { exact: true })).toHaveValue(
    DEFECT,
  );
  await retry
    .getByLabel("Administrator dispatch override reason")
    .fill(OVERRIDE_REASON);
  await retry.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "accepted", exact: true }),
  ).toHaveCount(1);
  // The retried flight filed the pilot's defect as an open report.
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await expect(page.getByText(DEFECT)).toBeVisible();
});

async function openDemo(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

async function createInspection(page: Page) {
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page.getByRole("button", { name: "New inspection" }).click();
  await page.getByLabel("Reference", { exact: true }).fill(REFERENCE);
  await page.getByLabel("Description", { exact: true }).fill("Workshop check");
  await page.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await page.getByLabel("Repeat every (hours)", { exact: true }).fill("100");
  await page.getByLabel("Last complied at (tracked hours)").fill("2300");
  await page
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

async function openDetails(page: Page) {
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: REFERENCE })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Inspection details" }),
  ).toBeVisible();
}

async function createAD(page: Page) {
  await page.goto("/airworthiness");
  await page.getByRole("button", { name: "Add AD", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("AD number", { exact: true }).fill(AD_NUMBER);
  await form
    .getByLabel("Subject", { exact: true })
    .fill("Inspect attachment fittings");
  await form
    .getByLabel("Applicability", { exact: true })
    .selectOption("Applicable");
  await form.getByLabel("Applicability and source changes reviewed").check();
  await form.getByRole("button", { name: "Add required action" }).click();
  await form
    .getByLabel("Required action", { exact: true })
    .fill("Inspect fittings");
  await form.getByLabel("Action recurrence").selectOption("Recurring");
  await form.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await form.getByLabel("Next due hours").fill("2300");
  await form.getByLabel("Repeat every hours").fill("100");
  await form.getByRole("button", { name: "Save AD", exact: true }).click();
  await expect(form).not.toBeVisible();
}

async function openADDetails(page: Page) {
  await page.goto("/airworthiness");
  await page.locator(".ad-register-group > summary").first().click();
  await page
    .getByRole("button", { name: `Details for AD ${AD_NUMBER}` })
    .click();
}

async function openADForm(page: Page) {
  await openADDetails(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Review / edit AD" })
    .first()
    .click();
}

async function recordCompliance(page: Page, hours: string) {
  await openADDetails(page);
  await page
    .getByRole("button", { name: "Record compliance", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Hours at completion").fill(hours);
  await form.getByLabel("Method of compliance").fill("Inspected; no defects");
  await form.getByRole("button", { name: "Save compliance" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function createWorkOrder(page: Page) {
  await page.getByRole("link", { name: "Work orders", exact: true }).click();
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Work order number").fill(WORK_ORDER_NUMBER);
  await form.getByLabel("Assigned supervisor").fill("First supervisor");
  await form
    .getByLabel("Additional requested work")
    .fill("Inspect cabin fittings");
  await form
    .getByRole("button", { name: "Add requested work", exact: true })
    .click();
  await form
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(form).not.toBeVisible();
}

async function openWorkOrder(page: Page) {
  await page.getByRole("link", { name: "Work orders", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: WORK_ORDER_NUMBER })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  return page.getByRole("dialog");
}

// The demo keeps every record in one IndexedDB snapshot; reading it shows
// what a save stored, including fields the screen does not print.
async function storedAD(page: Page): Promise<AD> {
  const all = await demoSnapshotOf(page);
  return all.airworthiness!.find((r) => r.source.number === AD_NUMBER)!;
}

async function storedWorkOrder(page: Page): Promise<WorkOrder> {
  const all = await demoSnapshotOf(page);
  return all.workOrders!.find((w) => w.number === WORK_ORDER_NUMBER)!;
}

function demoSnapshotOf(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return new Promise<Snapshot>((resolve, reject) => {
      const request = db
        .transaction("snapshots")
        .objectStore("snapshots")
        .get("demo:all");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  });
}
