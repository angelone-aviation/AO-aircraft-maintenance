import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { importFmd } from "../../src/data/fmd";
import { checklistCounts } from "../../src/domain/checklists";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/checklists");
  await expect(
    page.getByRole("heading", { name: "Checklists", exact: true }),
  ).toBeVisible();
});
test("imports N377YB, checks and skips offline, edits, exports and retains all original entries", async ({
  page,
  context,
}, testInfo) => {
  await page
    .getByLabel("Import FMD checklist file")
    .setInputFiles(
      path.resolve("tests/fixtures/N377YB complete Check List.fmd"),
    );
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "12 checklists · 598 entries · 401 checkable items",
  );
  await dialog
    .getByRole("button", { name: "Save checklist", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "N377YB", exact: true }),
  ).toBeVisible();
  const first = page
    .getByRole("region", { name: "Interactive checklist" })
    .getByRole("checkbox")
    .first();
  await expect(first).toContainText("1. LANDING GEAR HANDLE");
  await expect(first).toContainText("DOWN");
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Check next item", exact: true })
    .click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("button", { name: "Skip next item", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Interactive checklist" })
      .getByRole("status"),
  ).toContainText("1 skipped");
  await context.setOffline(false);
  await page.reload();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(
    page
      .getByRole("region", { name: "Interactive checklist" })
      .getByRole("status"),
  ).toContainText("1 skipped");
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Reset checklist", exact: true })
    .click();
  await expect(first).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("button", { name: "Next checklist", exact: true })
    .click();
  await expect(page.locator(".checklist-next")).toContainText("2 / 12");
  await page
    .getByRole("button", { name: "Previous checklist", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit checklist", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .locator(".checklist-edit-items details")
    .first()
    .locator("summary")
    .click();
  await dialog
    .getByLabel("Entry 1 challenge / heading", { exact: true })
    .fill("Landing gear handle — edited in test");
  await dialog
    .getByLabel("Entry 1 response / detail", { exact: true })
    .fill("DOWN (test edit)");
  await dialog
    .getByRole("button", { name: "Add heading / note", exact: true })
    .click();
  const added = dialog.locator(".checklist-edit-items details").last();
  await added.getByLabel(/challenge \/ heading/).fill("Test heading");
  await added
    .getByLabel(/response \/ detail/)
    .fill("A retained note\nWith a second line");
  await dialog
    .getByRole("button", { name: "Save checklist", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(first).toContainText("Landing gear handle — edited in test");
  await expect(
    page.getByRole("heading", { name: "Test heading", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .fmd", exact: true }).click();
  const downloaded = await downloadPromise;
  const target = testInfo.outputPath("export.fmd");
  await downloaded.saveAs(target);
  const exported = await importFmd(
    new Uint8Array(await readFile(target)).buffer,
  );
  const original = await importFmd(
    new Uint8Array(
      await readFile("tests/fixtures/N377YB complete Check List.fmd"),
    ).buffer,
  );
  expect(checklistCounts(exported)).toEqual({
    lists: 12,
    entries: 599,
    checks: 401,
  });
  const expected = structuredClone(original);
  expected.payload.groups[0].items[0].items[0].items[0].title =
    "Landing gear handle — edited in test";
  expected.payload.groups[0].items[0].items[0].items[0].detail =
    "DOWN (test edit)";
  expected.payload.groups[0].items[0].items[0].items.push(
    exported.payload.groups[0].items[0].items[0].items.at(-1)!,
  );
  expect(exported).toEqual(expected);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("checklist-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

test("creates editable groups and items and rejects damaged imports without losing a saved checklist", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "New checklist", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Checklist name", { exact: true })
    .fill("Custom aircraft checks");
  await dialog.getByRole("button", { name: "Add group", exact: true }).click();
  await dialog
    .getByLabel("Group title", { exact: true })
    .fill("Ground operations");
  await dialog
    .getByRole("button", { name: "Add checklist", exact: true })
    .click();
  await dialog
    .getByLabel("Checklist title", { exact: true })
    .fill("Before departure");
  await dialog
    .getByRole("button", { name: "Add check item", exact: true })
    .click();
  await dialog
    .getByLabel("Entry 1 challenge / heading", { exact: true })
    .fill("Documents");
  await dialog
    .getByLabel("Entry 1 response / detail", { exact: true })
    .fill("Checked");
  await dialog
    .getByRole("button", { name: "Save checklist", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Import FMD checklist file").setInputFiles({
    name: "bad.fmd",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("bad data"),
  });
  await expect(page.getByRole("alert")).toContainText("Invalid FMD");
  await expect(
    page.getByRole("checkbox", { name: "Documents Checked" }),
  ).toBeVisible();
});

test("switches through the searchable checklist library without losing checks", async ({
  page,
}) => {
  for (const name of ["Alpha procedures", "Bravo procedures"]) {
    await page
      .getByLabel("Import FMD checklist file")
      .setInputFiles(
        path.resolve("tests/fixtures/N377YB complete Check List.fmd"),
      );
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Checklist name", { exact: true }).fill(name);
    await dialog
      .getByRole("button", { name: "Save checklist", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
  }
  const reader = page.getByRole("region", { name: "Interactive checklist" });
  const first = reader.getByRole("checkbox").first();
  await reader
    .getByRole("button", { name: "Check next item", exact: true })
    .click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await reader.getByRole("button", { name: "Checklists", exact: true }).click();
  const library = page.getByRole("navigation", { name: "Checklist library" });
  await library.getByLabel("Search checklists").fill("Alpha");
  await expect(
    library.getByRole("button", { name: /Bravo procedures/ }),
  ).toHaveCount(0);
  await library.getByRole("button", { name: /Alpha procedures/ }).click();
  await expect(
    page.getByRole("navigation", { name: "Checklist sections" }),
  ).toBeVisible();
  await expect(first).toHaveAttribute("aria-checked", "false");
  await reader.getByRole("button", { name: "Checklists", exact: true }).click();
  await library.getByLabel("Search checklists").fill("");
  await library.getByRole("button", { name: /Bravo procedures/ }).click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await reader.getByRole("button", { name: "Checklists", exact: true }).click();
  await page.screenshot({ path: "/tmp/checklist-library.png", fullPage: true });
});

test("guided setup follows the checklist and linked aircraft selected in the library", async ({
  page,
}) => {
  for (const name of ["Alpha guided", "Bravo guided"]) {
    await page
      .getByLabel("Import FMD checklist file")
      .setInputFiles(
        path.resolve("tests/fixtures/N377YB complete Check List.fmd"),
      );
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Checklist name", { exact: true }).fill(name);
    // Use actual aircraft options rather than relying on fixture identifiers.
    await dialog
      .getByLabel("Checklist aircraft", { exact: true })
      .selectOption({ index: name.startsWith("Alpha") ? 1 : 2 });
    const aircraftId = await dialog
      .getByLabel("Checklist aircraft", { exact: true })
      .inputValue();
    await dialog
      .getByRole("button", { name: "Save checklist", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.getByLabel("Enable guided flight trial").check();
    await expect(
      page.getByLabel("Guided aircraft", { exact: true }),
    ).toHaveValue(aircraftId);
    await expect(
      page
        .getByLabel("Guided checklist", { exact: true })
        .locator("option:checked"),
    ).toHaveText(name);
  }
  const reader = page.getByRole("region", { name: "Interactive checklist" });
  await reader.getByRole("button", { name: "Checklists", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Checklist library" })
    .getByRole("button", { name: /Alpha guided/ })
    .click();
  await expect(
    page
      .getByLabel("Guided checklist", { exact: true })
      .locator("option:checked"),
  ).toHaveText("Alpha guided");
});

test("keeps a selected shared piston checklist when choosing another aircraft", async ({
  page,
}) => {
  for (const name of ["Twin procedures", "Mooney piston procedures"]) {
    await page
      .getByLabel("Import FMD checklist file")
      .setInputFiles(
        path.resolve("tests/fixtures/N377YB complete Check List.fmd"),
      );
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Checklist name", { exact: true }).fill(name);
    await dialog
      .getByLabel("Checklist aircraft", { exact: true })
      .selectOption("");
    await dialog
      .getByRole("button", { name: "Save checklist", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
  }
  await page.getByLabel("Enable guided flight trial").check();
  await page
    .getByLabel("Guided aircraft", { exact: true })
    .selectOption({ index: 1 });
  await expect(
    page
      .getByLabel("Guided checklist", { exact: true })
      .locator("option:checked"),
  ).toHaveText("Mooney piston procedures");
});
