import { test, expect } from "@playwright/test";

// A deliberately fictional, selectable-text manual; no real maintenance data.
function manualPdf() {
  const pages = [
    [
      "TEST MANUAL - NOT FOR MAINTENANCE",
      "INSPECTION PHASE 2",
      "1. Description",
      "A. Phase 2 consists of 100-hour or 12 calendar months, whichever occurs first,",
      "interval inspection items.",
      "B. Inspection items follow.",
      "A243003 Batteries - Inspect vents.",
      "5-12-02 Page 1",
    ],
    [
      "TEST MANUAL - NOT FOR MAINTENANCE",
      "LIFE LIMITED COMPONENTS",
      "(1) Test oxygen cylinder - Life limit 24 years or 4380 cycles",
      "5-11-00 Page 2",
    ],
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, lines] of pages.entries()) {
    const content = `BT /F1 10 Tf 40 760 Td 16 TL\n${lines.map((l, n) => `${n ? "T* " : ""}(${l.replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj`).join("\n")}\nET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("reviews manual suggestions inline, saves an inspection and creates a component with its life limit", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/manuals");
  await page
    .getByRole("button", { name: "Upload manual", exact: true })
    .click();
  const upload = page.getByRole("dialog", {
    name: "Upload reference manual",
    exact: true,
  });
  await upload
    .getByLabel("Manual title", { exact: true })
    .fill("Test discovery manual");
  await upload
    .getByLabel("Revision / temporary revisions", { exact: true })
    .fill("TEST-1");
  await upload.getByLabel("PDF manual", { exact: true }).setInputFiles({
    name: "discovery.pdf",
    mimeType: "application/pdf",
    buffer: manualPdf(),
  });
  await upload
    .getByRole("button", { name: "Save manual", exact: true })
    .click();
  await expect(upload).not.toBeVisible();
  await page
    .getByRole("button", { name: "Find maintenance items", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Find maintenance items",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Search manual", exact: true })
    .click();
  await expect(dialog.getByText(/Searched PDF pages 1–2/)).toBeVisible();
  const phase = dialog
    .getByRole("row")
    .filter({ hasText: "Phase 2 inspection" });
  await expect(phase).toContainText("100 hours");
  await expect(phase).toContainText("12 months");
  await phase
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  let form = dialog.getByRole("region", { name: "Create from manual item" });
  await form
    .getByLabel("Target aircraft", { exact: true })
    .selectOption("demo-206");
  await expect(
    form.getByLabel("Target aircraft").locator("option"),
  ).toHaveCount(2);
  await expect(
    form.getByLabel("Last complied at (aircraft hours)", { exact: true }),
  ).toHaveValue("");
  await form.getByRole("checkbox").check();
  await form
    .getByLabel("Last complied at (aircraft hours)", { exact: true })
    .fill("2300");
  await form
    .getByLabel("Last compliance date", { exact: true })
    .fill("2025-01-12");
  await expect(form.getByText(/Next due:/)).toContainText(
    "2400 aircraft hours or 2026-01-31",
  );
  await form
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await phase
    .getByRole("button", { name: "Create inspection", exact: true })
    .click();
  form = dialog.getByRole("region", { name: "Create from manual item" });
  await form
    .getByLabel("Target aircraft", { exact: true })
    .selectOption("demo-206");
  await expect(
    form.getByText(
      "This manual item has already been added to this aircraft. Edit it from Inspections.",
    ),
  ).toBeVisible();
  await form.getByRole("button", { name: "Close item form" }).click();
  const cylinder = dialog
    .getByRole("row")
    .filter({ hasText: "Test oxygen cylinder - Life limit" });
  await cylinder
    .getByRole("button", { name: "Create component", exact: true })
    .click();
  form = dialog.getByRole("region", { name: "Create from manual item" });
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByLabel("Component type", { exact: true })
    .selectOption("Appliance");
  await form.getByLabel("Component Name", { exact: true }).fill("TEST-CYL");
  await form.getByLabel("Part number", { exact: true }).fill("TEST-P1");
  await form.getByLabel("Serial number", { exact: true }).fill("TEST-S1");
  await form.getByLabel("Parts location", { exact: true }).fill("Test shelf");
  await expect(
    form.getByLabel("Time Since New (TSN) at install (hours)", { exact: true }),
  ).toHaveValue("");
  await form
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("50");
  await form
    .getByLabel("Component cycles at install", { exact: true })
    .fill("20");
  await form
    .getByLabel("Calendar time since new (months)", { exact: true })
    .fill("30");
  await form
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(form.getByText(/Component saved. Complete/)).toBeVisible();
  await expect(
    form.getByLabel("Requirement type", { exact: true }),
  ).toHaveValue("Life Limits");
  await expect(
    form.getByLabel("Cycle limit / interval", { exact: true }),
  ).toHaveValue("4380");
  await form
    .getByLabel("Last complied date", { exact: true })
    .fill("2025-01-12");
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await page.goto("/inspections");
  const inspection = page
    .getByRole("row")
    .filter({ hasText: "Phase 2 inspection" });
  await expect(inspection).toContainText("N206MA");
  await expect(inspection.getByRole("link")).toContainText("PDF page 1");
  await page.reload();
  await expect(inspection).toBeVisible();
  await page.goto("/components");
  const component = page.getByRole("row").filter({ hasText: "TEST-S1" });
  await component.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog");
  await expect(
    details.getByRole("row").filter({ hasText: "Life Limits" }),
  ).toContainText("4380");
  await expect(
    details.getByRole("link", { name: /PDF page 2/ }).first(),
  ).toBeVisible();
  await page.goto("/manuals");
  await page
    .getByRole("button", { name: "Find maintenance items", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Edit model association" }).click();
  await dialog
    .getByLabel("Manual applies to", { exact: true })
    .selectOption("component");
  await dialog.getByLabel("Manufacturer", { exact: true }).fill("");
  await dialog.getByLabel("Applicable model", { exact: true }).fill("TEST-CYL");
  await dialog.getByRole("button", { name: "Save model association" }).click();
  await expect(
    dialog.getByRole("button", { name: "Save model association" }),
  ).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Find maintenance items", exact: true })
    .click();
  await expect(dialog.getByText(/Associated component model:/)).toContainText(
    "TEST-CYL",
  );
  await dialog
    .getByRole("button", { name: "Search manual", exact: true })
    .click();
  await expect(dialog.getByText(/Searched PDF pages 1–2/)).toBeVisible();
  await expect(
    phase.getByRole("button", { name: "Create inspection", exact: true }),
  ).toBeDisabled();
  await phase
    .getByRole("button", {
      name: "Create component service requirement",
      exact: true,
    })
    .click();
  form = dialog.getByRole("region", { name: "Create from manual item" });
  await expect(
    form.getByLabel("Target component").locator("option"),
  ).toHaveCount(2);
  await form.getByLabel("Target component").selectOption({ index: 1 });
  await form.getByRole("checkbox", { name: /I checked/ }).check();
  await form
    .getByLabel("Last complied component hours", { exact: true })
    .fill("0");
  await form
    .getByLabel("Last complied date", { exact: true })
    .fill("2025-01-12");
  await form
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await phase
    .getByRole("button", {
      name: "Create component service requirement",
      exact: true,
    })
    .click();
  await form.getByLabel("Target component").selectOption({ index: 1 });
  await expect(
    form.getByText(
      "This manual item has already been added to this component. Edit it from Components.",
    ),
  ).toBeVisible();
});
