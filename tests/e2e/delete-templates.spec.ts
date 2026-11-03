import { test, expect } from "@playwright/test";
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
  await page.evaluate(async (s) => {
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
          entry.update({
            ...entry.value,
            inspectionTemplates: s.inspectionTemplates,
            inspections: s.inspections,
            taskCards: s.taskCards,
          });
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, fixture.s);
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
  const saved = await page.evaluate(
    async () =>
      new Promise<{ tasks: string[]; inspections: string[] }>(
        (resolve, reject) => {
          const r = indexedDB.open("angel-one-v1");
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              q = db.transaction("snapshots").objectStore("snapshots").getAll();
            q.onsuccess = () => {
              resolve({
                tasks: q.result.flatMap((s) =>
                  (s.taskCards ?? []).map((t: { uuid: string }) => t.uuid),
                ),
                inspections: q.result.flatMap((s) =>
                  (s.inspections ?? []).map((i: { uuid: string }) => i.uuid),
                ),
              });
              db.close();
            };
          };
        },
      ),
  );
  expect(saved.tasks).not.toContain(fixture.task.uuid);
  expect(saved.tasks).toContain(fixture.job.uuid);
  expect(saved.inspections).toContain(fixture.task.inspectionUuid);
});
