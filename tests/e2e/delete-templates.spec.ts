/**
 * Responsibility: Pins deleting inspection templates: selection, the cascade
 *   preview, cancelling without change, and deleting only the chosen
 *   template's reusable job cards while its activated inspection stays.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain/model (types),
 *   tests/fixtures/templateDeletion.
 */
import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/domain/model";
import { templateDeletionFixture } from "../fixtures/templateDeletion";
test("selects templates, previews the cascade, cancels safely and deletes associated reusable cards", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspection-templates");
  await expect(
    page.getByRole("heading", { name: "Inspection templates", exact: true }),
  ).toBeVisible();
  const fixture = templateDeletionFixture();
  await storeTemplateRecords(page, fixture.s);
  await page.reload();
  await page
    .getByRole("button", { name: "Delete templates", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select all visible", exact: true })
    .click();
  await page
    .getByLabel("Select template Keep phase", { exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Review deletion (1)", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete selected templates",
    exact: true,
  });
  await expect(dialog).toContainText("1 associated reusable job cards");
  await expect(dialog).not.toContainText("Keep phase");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: "Delete phase" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review deletion (1)", exact: true })
    .click();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", {
      name: "Delete 1 template and 1 job cards",
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Delete phase" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("row").filter({ hasText: "Keep phase" }),
  ).toBeVisible();
  await page.reload();
  const saved = await readStoredIds(page);
  expect(saved.tasks).not.toContain(fixture.task.uuid);
  expect(saved.tasks).toContain(fixture.job.uuid);
  expect(saved.inspections).toContain(fixture.task.inspectionUuid);
});

/**
 * Puts the fixture's templates, inspections and job cards into every snapshot
 * on the device, so the screen opens on them after a reload.
 */
async function storeTemplateRecords(page: Page, s: Snapshot) {
  const records = {
    inspectionTemplates: s.inspectionTemplates,
    inspections: s.inspections,
    taskCards: s.taskCards,
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
      entry.update({ ...entry.value, ...fields });
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
}

/** The job card and inspection uuids in every snapshot on the device. */
async function readStoredIds(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const snapshots = await new Promise<StoredIds[]>((resolve) => {
      const store = db.transaction("snapshots").objectStore("snapshots");
      const all = store.getAll();
      all.onsuccess = () => resolve(all.result);
    });
    db.close();
    return {
      tasks: snapshots.flatMap((s) => (s.taskCards ?? []).map((t) => t.uuid)),
      inspections: snapshots.flatMap((s) =>
        (s.inspections ?? []).map((i) => i.uuid),
      ),
    };
  });
}

interface StoredIds {
  taskCards?: { uuid: string }[];
  inspections?: { uuid: string }[];
}
