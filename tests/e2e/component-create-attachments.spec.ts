/**
 * Responsibility: Pins attaching a certificate while creating a component,
 *   from Components and from Inventory: the file-type refusal, the calendar
 *   fields, and retrying an upload that fails after the component is saved.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

for (const scenario of ["/components", "/inventory", "retry"]) {
  const route = scenario === "retry" ? "/components" : scenario;
  test(`attaches an 8130 during component creation from ${scenario}`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await createLocation(page, "Certificate store");
    await page.goto(route);
    await page
      .getByRole("button", {
        name: route === "/components" ? "New component" : "New stock item",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    if (route === "/inventory")
      await dialog
        .getByLabel("Category", { exact: true })
        .selectOption("component");
    await dialog
      .getByLabel("Component type", { exact: true })
      .selectOption("Appliance");
    await dialog.getByLabel("Part number", { exact: true }).fill("CERT-PART");
    await dialog.getByLabel("Serial number", { exact: true }).fill("CERT-001");
    await dialog
      .getByLabel("Component Name", { exact: true })
      .fill("Certificate test component");
    await dialog
      .getByLabel("Inventory location", { exact: true })
      .selectOption({ label: "Certificate store" });
    const calendarNew = dialog.getByLabel("Calendar time since new (months)", {
      exact: true,
    });
    const calendarOverhaul = dialog.getByLabel(
      "Calendar time since overhaul (months)",
      { exact: true },
    );
    await expect(calendarNew).toHaveValue("");
    await expect(calendarOverhaul).toHaveValue("");
    await dialog.getByLabel("Calendar", { exact: true }).uncheck();
    await expect(calendarNew).not.toBeVisible();
    await expect(calendarOverhaul).not.toBeVisible();
    await dialog.getByLabel("Calendar", { exact: true }).check();
    if (scenario === "/components") {
      await calendarNew.fill("12");
      await calendarOverhaul.fill("3");
    }
    const picker = dialog.getByLabel("Inventory attachment file");
    await picker.setInputFiles({
      name: "bad.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("invalid"),
    });
    await dialog
      .getByRole("button", { name: "Save component", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("Choose a PDF");
    await dialog
      .getByRole("button", { name: "Remove bad.txt", exact: true })
      .click();
    await picker.setInputFiles(
      path.resolve("tests/fixtures/icao-flight-plan.pdf"),
    );
    // Retry: the PNG's upload fails once after the component is saved, so
    // the dialog offers to upload that attachment again, not to save twice.
    if (scenario === "retry") {
      await picker.setInputFiles(path.resolve("public/icon-192.png"));
      await failFirstRead(page, "icon-192.png");
    }
    await dialog
      .getByRole("button", { name: "Save component", exact: true })
      .click();
    if (scenario === "retry") {
      await expect(dialog.getByRole("alert")).toContainText(
        "component was saved",
      );
      await expect(
        dialog.getByRole("button", { name: "Save component", exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", {
          name: "Remove icao-flight-plan.pdf",
          exact: true,
        }),
      ).toHaveCount(0);
      await dialog
        .getByRole("button", { name: "Upload attachment", exact: true })
        .click();
    }
    await expect(dialog).not.toBeVisible();
    await page.reload();
    const row = page.getByRole("row").filter({ hasText: "CERT-PART" });
    await expect(row).toHaveCount(1);
    if (scenario === "/components") {
      await expect(row).toContainText("Calendar time since new: 12.0 months");
      await expect(row).toContainText(
        "Calendar time since overhaul: 3.0 months",
      );
    }
    if (scenario === "retry") {
      await expect(row).toContainText("Calendar time since new: Unknown");
      await expect(row).toContainText("Calendar time since overhaul: Unknown");
    }
    await row.getByRole("button", { name: "Details", exact: true }).click();
    await expect(
      dialog.getByRole("link", { name: "Open PDF", exact: true }),
    ).toBeVisible();
    if (scenario === "retry") {
      await expect(
        dialog.getByRole("img", { name: "icon-192.png", exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: "Open PDF", exact: true }),
      ).toHaveCount(1);
    }
    await expect(
      dialog.getByRole("link", {
        name: "Download icao-flight-plan.pdf",
        exact: true,
      }),
    ).toBeVisible();
  });
}

async function createLocation(page: Page, name: string) {
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New location", exact: true }).click();
  await page.getByLabel("Location name", { exact: true }).fill(name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

/** Makes the browser's first read of the named file fail, as a lost upload. */
async function failFirstRead(page: Page, fileName: string) {
  await page.evaluate((name) => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== name) return original.call(this);
      File.prototype.arrayBuffer = original;
      return Promise.reject(new Error("Simulated upload interruption"));
    };
  }, fileName);
}
