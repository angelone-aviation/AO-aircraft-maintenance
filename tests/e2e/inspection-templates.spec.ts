/**
 * Responsibility: Pins inspection templates: interval-only CSV imports grouped
 *   by aircraft type, editing without compliance, templates saved from a
 *   manual's CSV, and creating an inspection from a template once.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, src/domain (maintenanceCsv,
 *   csv).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { importHeaders } from "../../src/domain/maintenanceCsv";
import { toCsv } from "../../src/domain/csv";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
});
test("imports interval-only templates grouped by aircraft type, persists and edits without compliance", async ({
  page,
}) => {
  const dialog = await openTemplateImport(page);
  await dialog.getByLabel("Inspection group", { exact: true }).fill("Phases");
  await dialog
    .getByLabel("Template CSV", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/c441-template-source.csv"));
  await dialog.getByRole("button", { name: "Preview templates" }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Include row 2", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Include row 3", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("checkbox", { name: /I reviewed/ }).check();
  await dialog.getByRole("button", { name: "Save selected templates" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Aircraft type: Cessna 441 / Phases" }),
  ).toBeVisible();
  await page.getByLabel("Search templates").fill("Phase 2");
  const row = page.getByRole("row").filter({
    has: page.getByRole("cell", {
      name: "Phase 2 Inspection Requirement",
      exact: true,
    }),
  });
  await row.getByRole("button", { name: "Edit template" }).click();
  const editor = page.getByRole("dialog", {
    name: "Inspection template",
    exact: true,
  });
  await expect(
    editor.getByLabel("Hour interval / limit", { exact: true }),
  ).toHaveValue("100");
  await expect(
    editor.locator(
      'input[name="lastDate"],input[name="lastSeconds"],input[name="dueDate"]',
    ),
  ).toHaveCount(0);
  await editor.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await editor.getByLabel("Hour interval / limit", { exact: true }).fill("110");
  await saveTemplate(editor);
  await page.reload();
  await page.getByLabel("Search templates").fill("Phase 2");
  await expect(row).toContainText("110 hours");
  await page.getByRole("button", { name: "New template" }).click();
  await editor
    .getByLabel("Template name", { exact: true })
    .fill("Pump inspection");
  await editor
    .getByLabel("Group by", { exact: true })
    .selectOption("component");
  await editor
    .getByLabel("Aircraft type / component model", { exact: true })
    .fill("P100");
  await editor.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await editor.getByLabel("Hour interval / limit", { exact: true }).fill("500");
  await saveTemplate(editor);
  await page.getByLabel("Search templates").fill("");
  await expect(
    page.getByRole("heading", { name: /Component model:.*P100/ }),
  ).toBeVisible();
});
test("saves manual CSV candidates and linked tasks as a reusable template", async ({
  page,
}) => {
  await page.goto("/manuals");
  await page
    .getByRole("button", { name: "Upload manual", exact: true })
    .click();
  const upload = page.getByRole("dialog", { name: "Upload reference manual" });
  await upload
    .getByLabel("Manual title", { exact: true })
    .fill("Template source");
  await upload
    .getByLabel("Revision / temporary revisions", { exact: true })
    .fill("TEST");
  await upload
    .getByLabel("PDF manual", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await upload
    .getByRole("button", { name: "Save manual", exact: true })
    .click();
  await expect(upload).not.toBeVisible();
  await page
    .getByRole("button", { name: "Import maintenance CSV", exact: true })
    .click();
  const csv = page.getByRole("dialog", {
    name: "Import maintenance CSV",
    exact: true,
  });
  await csv.getByLabel("Inspections CSV").setInputFiles(
    csvFile("inspections", {
      id: "phase",
      name: "Reusable phase",
      description: "Inspect seals",
      repeat_hours: 100,
      pdf_page: 1,
    }),
  );
  await csv.getByLabel("Tasks CSV").setInputFiles(
    csvFile("tasks", {
      id: "seal",
      parent_type: "inspection",
      parent_id: "phase",
      instruction: "Check seal condition",
      item_code: "A1",
      pdf_page: 1,
    }),
  );
  await csv.getByRole("button", { name: "Validate and preview CSVs" }).click();
  await csv
    .getByRole("button", { name: "Save as template", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Save CSV as template",
    exact: true,
  });
  await expect(editor.getByText("1 reusable checklist tasks")).toBeVisible();
  await saveTemplate(editor);
  await page.goto("/inspection-templates");
  await expect(
    page.getByRole("cell", {
      name: "Reusable phase Inspection Requirement",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: /1 tasks/ })).toBeVisible();
});

test("creates an aircraft inspection from a template with compliance and blocks duplicate creation", async ({
  page,
}) => {
  await page.goto("/inspection-templates");
  await page.getByRole("button", { name: "New template", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Inspection template",
    exact: true,
  });
  await editor
    .getByLabel("Template name", { exact: true })
    .fill("Activated phase");
  await editor.getByLabel("Manufacturer", { exact: true }).fill("Cessna");
  await editor
    .getByLabel("Aircraft type / component model", { exact: true })
    .fill("206 Stationair");
  await editor.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await editor.getByLabel("Hour interval / limit", { exact: true }).fill("100");
  await editor.getByRole("checkbox", { name: "Calendar", exact: true }).check();
  await editor.getByLabel("Calendar interval", { exact: true }).fill("12");
  await saveTemplate(editor);
  await page
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "Create inspection from template",
    exact: true,
  });
  await create
    .getByLabel("Target aircraft", { exact: true })
    .selectOption("demo-206");
  await create
    .getByLabel("Last complied at (selected time source hours)", {
      exact: true,
    })
    .fill("2200");
  await create
    .getByLabel("Last compliance date", { exact: true })
    .fill("2025-12-12");
  // Calendar months run to the end of the due month (14 CFR 91.409).
  await expect(create.getByRole("status")).toContainText("2026-12-31");
  await create.getByRole("checkbox", { name: /I reviewed/ }).check();
  await create
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(create).not.toBeVisible();
  await page
    .getByRole("link", { name: "Open Inspections", exact: true })
    .click();
  // Complied at 2,200 hours, due 100 hours later.
  await expect(
    page.getByRole("row").filter({ hasText: "Activated phase" }),
  ).toContainText("2,300.0 h");
  await page.goto("/inspection-templates");
  await page
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  await create
    .getByLabel("Target aircraft", { exact: true })
    .selectOption("demo-206");
  await expect(
    create.getByText("This schedule already exists.", { exact: false }),
  ).toBeVisible();
  await expect(
    create.getByRole("button", { name: "Save inspection", exact: true }),
  ).toBeDisabled();
});

test("imports all 59 supplied C441 inspection rows including narrative-only requirements", async ({
  page,
}) => {
  const dialog = await openTemplateImport(page);
  await dialog
    .getByLabel("Template CSV", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/c441-inspections-source.csv"));
  await dialog
    .getByRole("button", { name: "Preview templates", exact: true })
    .click();
  await expect(dialog).toContainText("59 rows · 59 valid · 0 errors");
  await expect(
    dialog.getByRole("checkbox", { name: /Include row/ }),
  ).toHaveCount(59);
  await expect(
    dialog
      .getByRole("row")
      .filter({ hasText: "C441 Hard or Overweight Landing Check" }),
  ).toContainText("Event-triggered.");
  await dialog.getByRole("checkbox", { name: /I reviewed/ }).check();
  await dialog
    .getByRole("button", { name: "Save selected templates", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByLabel("Search templates").fill("C441 Phase 56");
  await expect(
    page.getByRole("row").filter({ hasText: "C441 Phase 56" }),
  ).toContainText(
    "Numeric interval intentionally blank until environment is determined.",
  );
  await page
    .getByRole("button", { name: "Edit template", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Inspection template",
    exact: true,
  });
  await expect(
    editor.getByLabel("Hour interval / limit", { exact: true }),
  ).toHaveValue("");
});

/** Opens the template CSV import for Cessna 441 templates. */
async function openTemplateImport(page: Page): Promise<Locator> {
  await page.goto("/inspection-templates");
  await page
    .getByRole("button", { name: "Import template CSV", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import interval templates",
    exact: true,
  });
  await dialog.getByLabel("Manufacturer", { exact: true }).fill("Cessna");
  await dialog
    .getByLabel("Aircraft type / component model", { exact: true })
    .fill("441");
  return dialog;
}

async function saveTemplate(editor: Locator) {
  await editor
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
}

/** A one-row maintenance CSV upload with every header, blank unless given. */
function csvFile(kind: "inspections" | "tasks", row: Record<string, unknown>) {
  const blank = Object.fromEntries(importHeaders[kind].map((h) => [h, ""]));
  return {
    name: kind + ".csv",
    mimeType: "text/csv",
    buffer: Buffer.from(toCsv([{ ...blank, ...row }])),
  };
}
