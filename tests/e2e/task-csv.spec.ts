import { test, expect } from "@playwright/test";
import path from "node:path";
test("imports the sample task file to one template or inspection, retains metadata and blocks duplicate batches", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspection-templates");
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
  await page
    .getByRole("button", { name: "Import Jobs CSV", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import Jobs to a template or inspection",
    exact: true,
  });
  await dialog
    .getByLabel("Target template", { exact: true })
    .selectOption({ index: 1 });
  await dialog
    .getByLabel("Task CSV file", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/phase-2-tasks.csv"));
  await dialog
    .getByRole("button", { name: "Preview task file", exact: true })
    .click();
  await expect(
    dialog.getByText(/14 tasks → Phase 2 task target/),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("cell", { name: "5-12-02 page 1 · PDF page 79", exact: true })
      .first(),
  ).toBeVisible();
  await dialog.getByRole("checkbox", { name: /I reviewed this file/ }).check();
  await dialog
    .getByRole("button", { name: "Import all 14 tasks", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("14 tasks imported");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
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
  await editor
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.goto("/inspections");
  await page
    .getByRole("button", { name: "Import Jobs CSV", exact: true })
    .click();
  await expect(dialog.getByLabel("Attach whole file to")).toHaveValue(
    "inspection",
  );
  await dialog
    .getByLabel("Target inspection", { exact: true })
    .selectOption("demo-insp-1");
  await dialog
    .getByLabel("Task CSV file", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/phase-2-tasks.csv"));
  await dialog
    .getByRole("button", { name: "Preview task file", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: /I reviewed this file/ }).check();
  await dialog
    .getByRole("button", { name: "Import all 14 tasks", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("14 tasks imported");
  await dialog
    .getByRole("button", { name: "Preview task file", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: /I reviewed this file/ }).check();
  await dialog
    .getByRole("button", { name: "Import all 14 tasks", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Job card templates (14)", exact: true }),
  ).toBeVisible();
  await page.goto("/task-cards");
  await page.getByLabel("Search job cards", { exact: true }).fill("A243003");
  await page.getByRole("button", { name: /^Details for TC-/ }).click();
  await expect(
    page.getByLabel("Maintenance-data reference", { exact: true }),
  ).toHaveValue("5-12-02 page 1 · PDF page 79");
});
