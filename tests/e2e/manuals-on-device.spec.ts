/**
 * Responsibility: Pins manuals kept on this device: kept per deployment and
 *   user, opened offline from the library and an inspection reference,
 *   removed from the viewer, and cleared on sign-out.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, jspdf.
 */
import { test, expect, type Page } from "@playwright/test";
import { jsPDF } from "jspdf";

test("keeps a manual on this device and opens it offline from the library and an inspection reference", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await openDemo(page);
  const { row, uuid } = await uploadManual(page, "Hangar maintenance manual");
  // Forget the PDF viewer files the upload check cached, as on a device that
  // never opened a manual: keeping one must cache them for offline use.
  await page.evaluate(() => caches.delete("on-demand-documents"));
  await page.reload();
  const summary = page.getByRole("region", { name: "Manuals on this device" });
  await expect(summary).toContainText("None kept yet");

  await row.getByRole("button", { name: "Keep on this device" }).click();
  await expect(row.getByText("On this device", { exact: true })).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Remove from this device" }),
  ).toBeVisible();
  await expect(summary).toContainText(/1 manual · \d+\.\d MB used/);
  await expect(summary).toContainText(/left/);
  // Stored per deployment and user, keyed by the manual's UUID.
  const entries = await keptEntries(page);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toContain('["demo","demo-admin"]');
  expect(entries[0]).toContain(uuid);
  expect(entries[0]).not.toContain("blob:");

  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "100-hour inspection" })
    .first()
    .getByRole("button", { name: "Details", exact: true })
    .click();
  const editor = page.getByRole("dialog");
  await editor
    .getByLabel("Reference library manual", { exact: true })
    .selectOption({ label: "Hangar maintenance manual · Rev 4" });
  await editor.getByLabel("Manual section", { exact: true }).fill("5-12-02");
  await editor.getByLabel("PDF page number", { exact: true }).fill("2");
  await editor
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(editor).not.toBeVisible();

  // From here on only the copy kept on this device can open the manual.
  await deleteDemoManualFile(page, uuid);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole("link", { name: "Reference library" }).first().click();
  await expect(row.getByText("On this device", { exact: true })).toBeVisible();
  await row.getByRole("link", { name: "Open manual", exact: true }).click();
  await expect(page.locator(".pdf-reader canvas")).toHaveAttribute(
    "aria-label",
    "Hangar maintenance manual — PDF page 1",
  );
  const panel = page.getByRole("region", { name: "This device" });
  await expect(panel).toContainText("Opened from this device");

  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page
    .getByRole("link", { name: /Hangar maintenance manual.*PDF page 2/ })
    .click();
  const viewer = page.getByRole("dialog", {
    name: "Manual reference",
    exact: true,
  });
  await expect(viewer.locator(".pdf-reader canvas")).toHaveAttribute(
    "aria-label",
    "Hangar maintenance manual — PDF page 2",
  );

  await viewer
    .getByRole("button", { name: "Remove from this device", exact: true })
    .click();
  await expect(
    viewer.getByRole("region", { name: "This device" }),
  ).toContainText("Not on this device");
  // Keeping a manual downloads it, which needs the connection that is off.
  await expect(
    viewer.getByRole("button", { name: "Keep on this device" }),
  ).toBeDisabled();
  expect(await keptEntries(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Reference library" }).first().click();
  await expect(
    row.getByRole("button", { name: "Keep on this device" }),
  ).toBeVisible();
  await expect(summary).toContainText("None kept yet");
  await row.getByRole("link", { name: "Open manual", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Manual file is unavailable in this browser.",
  );
  await context.setOffline(false);
});

test("keeps a manual from the viewer and removes kept manuals on sign-out", async ({
  page,
}) => {
  await openDemo(page);
  const { row } = await uploadManual(page, "Sign-out manual");
  await row.getByRole("link", { name: "Open manual", exact: true }).click();
  const panel = page.getByRole("region", { name: "This device" });
  await expect(panel).toContainText("Not on this device");
  await panel.getByRole("button", { name: "Keep on this device" }).click();
  await expect(panel).toContainText("On this device");
  await expect(
    panel.getByRole("button", { name: "Remove from this device" }),
  ).toBeVisible();
  expect(await keptEntries(page)).toHaveLength(1);

  // Sign-out reloads the page and clears kept manuals, but not the library.
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  expect(await keptEntries(page)).toEqual([]);
  await page.getByRole("link", { name: "Reference library" }).first().click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Sign-out manual" })
      .getByRole("button", { name: "Keep on this device" }),
  ).toBeVisible();
});

/** Opens the demo with the service worker controlling the page. */
async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  const home = page.getByRole("heading", { name: "Your fleet, at a glance." });
  await expect(home).toBeVisible();
  // The service worker controls only pages loaded after it activates.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(home).toBeVisible();
}

/**
 * Uploads a three-page manual at Rev 4 through the Reference library.
 *
 * @returns The manual's library row and its uuid, read from the Open link.
 */
async function uploadManual(page: Page, title: string) {
  await page.getByRole("link", { name: "Reference library" }).first().click();
  await page
    .getByRole("button", { name: "Upload manual", exact: true })
    .click();
  const upload = page.getByRole("dialog", {
    name: "Upload reference manual",
    exact: true,
  });
  await upload.getByLabel("Manual title", { exact: true }).fill(title);
  await upload
    .getByLabel("Revision / temporary revisions", { exact: true })
    .fill("Rev 4");
  await upload.getByLabel("PDF manual", { exact: true }).setInputFiles({
    name: "manual.pdf",
    mimeType: "application/pdf",
    buffer: manualPdf(title),
  });
  await upload
    .getByRole("button", { name: "Save manual", exact: true })
    .click();
  await expect(upload).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: title });
  const href = await row
    .getByRole("link", { name: "Open manual", exact: true })
    .getAttribute("href");
  return { row, uuid: href!.split("?")[0].split("/").pop()! };
}

/** A three-page PDF whose pages read "<title> page <n>". */
function manualPdf(title: string) {
  const pdf = new jsPDF();
  for (let i = 1; i <= 3; i++) {
    if (i > 1) pdf.addPage();
    pdf.text(`${title} page ${i}`, 20, 30);
  }
  return Buffer.from(pdf.output("arraybuffer"));
}

/** `cache name → entry URL` for each manual kept on this device. */
async function keptEntries(page: Page) {
  return page.evaluate(async () => {
    const entries: string[] = [];
    const names = (await caches.keys()).filter((name) =>
      name.startsWith("angel-one-kept-manuals"),
    );
    for (const name of names) {
      const requests = await (await caches.open(name)).keys();
      entries.push(...requests.map((request) => `${name} → ${request.url}`));
    }
    return entries;
  });
}

/** Deletes the demo backend's own copy of the uploaded manual's file. */
async function deleteDemoManualFile(page: Page, uuid: string) {
  await page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-manuals-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, "demo:" + uuid);
}
