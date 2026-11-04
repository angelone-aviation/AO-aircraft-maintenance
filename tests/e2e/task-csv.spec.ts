/**
 * Responsibility: Pins the Jobs CSV import: the sample task file lands on one
 *   template or inspection, keeps its task metadata and maintenance-data
 *   references, and a second import of the same file is refused.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";

const TASK_CSV = path.resolve("tests/fixtures/phase-2-tasks.csv");
const FIRST_TASK_REFERENCE = "5-12-02 page 1 · PDF page 79";

test("imports the sample task file to one template or inspection, retains metadata and blocks duplicate batches", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspection-templates");
  const editor = await createHourTemplate(page);
  const dialog = await openTaskImport(page);
  await dialog
    .getByLabel("Target template", { exact: true })
    .selectOption({ index: 1 });
  await dialog
    .getByLabel("Task CSV file", { exact: true })
    .setInputFiles(TASK_CSV);
  await previewTaskFile(dialog);
  await expect(
    dialog.getByText(/14 tasks → Phase 2 task target/),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("cell", { name: FIRST_TASK_REFERENCE, exact: true })
      .first(),
  ).toBeVisible();
  await importReviewedTasks(dialog);
  await expect(dialog.getByRole("status")).toContainText("14 tasks imported");
  await closeDialog(dialog);
  await expectTemplateKeepsMetadata(page, editor);
  await importTwiceToInspection(page);
  await expect(
    page.getByRole("button", { name: "Job card templates (14)", exact: true }),
  ).toBeVisible();
  await page.goto("/task-cards");
  await page.getByLabel("Search job cards", { exact: true }).fill("A243003");
  await page.getByRole("button", { name: /^Details for TC-/ }).click();
  await expect(
    page.getByLabel("Maintenance-data reference", { exact: true }),
  ).toHaveValue(FIRST_TASK_REFERENCE);
});

/** Saves an hour-limited template for the 441 and returns its editor. */
async function createHourTemplate(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "New template", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Inspection template",
    exact: true,
  });
  await editor
    .getByLabel("Template name", { exact: true })
    .fill("Phase 2 task target");
  await editor
    .getByLabel("Aircraft type / component model", { exact: true })
    .fill("441");
  await editor.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await editor.getByLabel("Hour interval / limit", { exact: true }).fill("100");
  await editor
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  return editor;
}

async function openTaskImport(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: "Import Jobs CSV", exact: true })
    .click();
  return page.getByRole("dialog", {
    name: "Import Jobs to a template or inspection",
    exact: true,
  });
}

/** After a reload, the template lists the 14 tasks with their zone. */
async function expectTemplateKeepsMetadata(page: Page, editor: Locator) {
  await page.reload();
  await expect(
    page.getByRole("cell", { name: "14 tasks", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit template", exact: true })
    .click();
  await editor.getByText("14 reusable checklist tasks").click();
  await expect(
    editor.getByText("Zone: 131", { exact: true }).first(),
  ).toBeVisible();
  await closeDialog(editor);
}

/** Imports the file to the first demo inspection, then the same batch again. */
async function importTwiceToInspection(page: Page) {
  await page.goto("/inspections");
  const dialog = await openTaskImport(page);
  await expect(dialog.getByLabel("Attach whole file to")).toHaveValue(
    "inspection",
  );
  await dialog
    .getByLabel("Target inspection", { exact: true })
    .selectOption("demo-insp-1");
  await dialog
    .getByLabel("Task CSV file", { exact: true })
    .setInputFiles(TASK_CSV);
  await previewTaskFile(dialog);
  await importReviewedTasks(dialog);
  await expect(dialog.getByRole("status")).toContainText("14 tasks imported");
  await previewTaskFile(dialog);
  await importReviewedTasks(dialog);
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await closeDialog(dialog);
}

async function previewTaskFile(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Preview task file", exact: true })
    .click();
}

/** Confirms the file was reviewed, which the import requires, and imports. */
async function importReviewedTasks(dialog: Locator) {
  await dialog.getByRole("checkbox", { name: /I reviewed this file/ }).check();
  await dialog
    .getByRole("button", { name: "Import all 14 tasks", exact: true })
    .click();
}

async function closeDialog(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
}
