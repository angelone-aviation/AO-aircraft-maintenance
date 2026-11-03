import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  importHeaders,
  type ImportKind,
} from "../../src/domain/maintenanceCsv";
import { toCsv } from "../../src/domain/csv";
const file = (kind: ImportKind, rows: Record<string, unknown>[]) => ({
  name: `${kind}.csv`,
  mimeType: "text/csv",
  buffer: Buffer.from(
    toCsv(
      rows.map((r) => ({
        ...Object.fromEntries(importHeaders[kind].map((h) => [h, ""])),
        ...r,
      })),
    ),
  ),
});

test("imports reviewed inspection, component requirement and linked draft task with persistence and duplicate checks", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/manuals");
  await page
    .getByRole("button", { name: "Upload manual", exact: true })
    .click();
  const upload = page.getByRole("dialog", { name: "Upload reference manual" });
  await upload
    .getByLabel("Manual title", { exact: true })
    .fill("CSV test source — fictional data");
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
  const dialog = page.getByRole("dialog", {
    name: "Import maintenance CSV",
    exact: true,
  });
  const instructions = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Download AI instructions" })
    .click();
  expect((await instructions).suggestedFilename()).toBe(
    "maintenance-csv-ai-instructions.txt",
  );
  await dialog.getByLabel("Inspections CSV").setInputFiles(
    file("inspections", [
      {
        id: "test-phase",
        name: "CSV test phase",
        description: 'Inspect vents, seals and "connections".',
        initial_hours: 2000,
        repeat_hours: 100,
        repeat_months: 12,
        pdf_page: 1,
      },
    ]),
  );
  await dialog.getByLabel("Components CSV").setInputFiles(
    file("components", [
      {
        id: "test-pump",
        name: "CSV test pump",
        description: "Fictional test limit",
        component_model: "TEST-MODEL",
        manufacturer: "TEST",
        part_number: "TEST-PN",
        requirement_type: "life_limit",
        cycle_limit: 1000,
        calendar_value: 24,
        calendar_unit: "MONTHS",
        time_basis: "TSN",
        hour_mode: "ABSOLUTE",
        cycle_mode: "ABSOLUTE",
        pdf_page: 1,
      },
    ]),
  );
  await dialog.getByLabel("Tasks CSV").setInputFiles(
    file("tasks", [
      {
        id: "test-step",
        parent_type: "inspection",
        parent_id: "missing",
        instruction: "Check test vents",
        pdf_page: 1,
      },
    ]),
  );
  await dialog
    .getByRole("button", { name: "Validate and preview CSVs" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "parent missing was not found",
  );
  await expect(
    dialog.getByRole("button", { name: "Create inspection", exact: true }),
  ).toHaveCount(0);
  await dialog.getByLabel("Tasks CSV").setInputFiles(
    file("tasks", [
      {
        id: "test-step",
        parent_type: "inspection",
        parent_id: "test-phase",
        item_code: "TEST-A1",
        instruction: "Check test vents",
        applicability: "Test fixture only",
        pdf_page: 1,
      },
    ]),
  );
  await dialog
    .getByRole("button", { name: "Validate and preview CSVs" })
    .click();
  await expect(
    dialog.getByText(
      "Ready for review: 1 inspections, 1 component requirements, 1 tasks.",
    ),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Create job card template", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "CSV task form" }),
  ).toContainText("Save the parent inspection");
  await dialog
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  let form = dialog.getByRole("region", { name: "CSV record form" });
  await form.getByLabel("Target aircraft").selectOption("demo-206");
  await form.getByLabel("Schedule to create").selectOption("initial");
  await expect(
    form.getByLabel("Repeat every (hours)", { exact: true }),
  ).toBeDisabled();
  await expect(
    form.getByLabel("One-time due (aircraft hours)", { exact: true }),
  ).toHaveValue("2000");
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await dialog
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  await form.getByLabel("Target aircraft").selectOption("demo-206");
  await form.getByLabel("Schedule to create").selectOption("recurring");
  await form
    .getByLabel("Last complied at (aircraft hours)", { exact: true })
    .fill("2300");
  await form
    .getByLabel("Last compliance date", { exact: true })
    .fill("2025-01-12");
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await dialog
    .getByRole("button", { name: "Create component", exact: true })
    .click();
  await expect(form.getByLabel("Component Name")).toHaveValue("TEST-MODEL");
  await expect(form.getByLabel("Part number", { exact: true })).toHaveValue(
    "TEST-PN",
  );
  await form.getByLabel("Serial number", { exact: true }).fill("CSV-S1");
  await form.getByLabel("Parts location").fill("Test shelf");
  await form
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("10");
  await form.getByLabel("Component cycles at install").fill("10");
  await form.getByLabel("Calendar time since new (months)").fill("10");
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(form.getByText(/Component saved/)).toBeVisible();
  await expect(
    form.getByLabel("Cycle limit / interval", { exact: true }),
  ).toHaveValue("1000");
  await form
    .getByLabel("Last complied date", { exact: true })
    .fill("2025-01-12");
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await dialog
    .getByRole("button", { name: "Create job card template", exact: true })
    .click();
  const taskForm = dialog.getByRole("region", { name: "CSV task form" });
  await taskForm
    .getByLabel("Saved parent record")
    .selectOption({ label: "N206MA · CSV test phase" });
  await taskForm.getByRole("checkbox", { name: /I checked/ }).check();
  await taskForm.getByRole("button", { name: "Save draft task" }).click();
  await expect(taskForm).not.toBeVisible();
  await dialog
    .getByRole("button", { name: "Create job card template", exact: true })
    .click();
  await taskForm
    .getByLabel("Saved parent record")
    .selectOption({ label: "N206MA · CSV test phase" });
  await expect(taskForm).toContainText("already been imported");
  await page.goto("/task-cards");
  await page.reload();
  const taskRow = page.getByRole("row").filter({ hasText: "TEST-A1" });
  // Templates are marked by their signoff cell: only copies can be signed.
  await expect(taskRow.getByLabel(/^Signoffs for TC-/)).toHaveText(
    "Sign on the work-order copy.",
  );
  await taskRow.getByRole("button", { name: /^Details for TC-/ }).click();
  await expect(
    page.getByRole("dialog").getByLabel("Applicability", { exact: true }),
  ).toHaveValue("Test fixture only");
  await page.goto("/inspections");
  const phaseRows = page.getByRole("row").filter({ hasText: "CSV test phase" });
  await expect(phaseRows).toHaveCount(2);
  await expect(phaseRows.first()).toContainText("2,000.0");
  await expect(phaseRows.last()).toContainText("2,400.0");
});
