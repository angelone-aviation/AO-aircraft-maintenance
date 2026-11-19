/**
 * Responsibility: Pins job card templates on a work order: copies carry the
 *   execution and signoffs, the inspection task completes only when every
 *   copy is signed, closing is confirmed and permanent, and the logbook entry
 *   (text, templates, copy and PDF) includes the signed cards.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, pdfjs-dist (legacy Node build), node:fs,
 *   src/domain/model (localDate), tests/fixtures/workOrderTasks.
 */
import {
  test,
  expect,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { localDate } from "../../src/domain/model";
import { expandTask } from "../fixtures/workOrderTasks";

const HOUR_SECONDS = 3600;
const ORDER = "WO-TEMPLATE-COPY";
const SEAL_CHECK_CARD = /TC-.*Seal check template/;
const COMPLETED_OPTION = 'option[value="completed"]';
// Long enough that the saved PDF needs a second page.
const REVIEW_LINES = 85;

test("copies job card templates into an order, permits execution only on copies and gates inspection completion on all signoffs", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspections");
  await expect(
    page.getByRole("heading", { name: "Inspections", exact: true }),
  ).toBeVisible();
  await storeInspectionInterval(page);
  await page.reload();

  const source = page
    .getByRole("row")
    .filter({ hasText: "100-hour inspection" })
    .filter({ hasText: "N206MA" });
  const templates = page.getByRole("dialog", {
    name: "Linked job card templates",
    exact: true,
  });
  const editor = page.getByRole("dialog", { name: /Job card TC-/ });
  await createSealCheckTemplate(page, source, templates);
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Technician signoff", exact: true }),
  ).toHaveCount(0);
  await openOrderForInspection(page);
  const orderRow = page.getByRole("row").filter({ hasText: ORDER });
  await orderRow.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", { name: ORDER, exact: true });
  await expandTask(details, 1);
  const taskStatus = details.getByLabel("Task 1 status");
  await expect(taskStatus.locator(COMPLETED_OPTION)).toBeDisabled();
  // Each task's job cards are a collapsible group.
  const nestedCards = details.getByRole("group", {
    name: "Job cards for 100-hour inspection: Airframe and engine inspection",
    exact: true,
  });
  await expect(nestedCards.locator("> summary")).toHaveText("Job cards (1)");
  await nestedCards.locator("> summary").click();
  await expect(nestedCards).toContainText("Technician: Pending");
  await nestedCards.getByRole("button", { name: SEAL_CHECK_CARD }).click();
  await signOffCopiedCard(editor);
  await expect(nestedCards).toContainText("Technician: Signed");
  await expect(taskStatus.locator(COMPLETED_OPTION)).toBeEnabled();
  await taskStatus.selectOption("completed");
  await saveOrderButton(details).click();
  await expect(details).not.toBeVisible();
  await orderRow.getByRole("button", { name: "Details", exact: true }).click();
  await closeOrderAfterConfirming(page, details);
  await page.getByLabel("Include closed work orders").check();
  await orderRow.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    details.getByText("1 inspection compliance record(s) updated at closeout."),
  ).toBeVisible();
  await expandTask(details, 1);
  await nestedCards.locator("> summary").click();
  await nestedCards.getByRole("button", { name: SEAL_CHECK_CARD }).click();
  await expect(
    editor.getByLabel("Actual work performed", { exact: true }),
  ).toHaveValue("Seal inspected");
  await expect(saveCardButton(editor)).toBeDisabled();
  await closeDialog(editor);
  await details
    .getByRole("button", { name: "Generate logbook entry", exact: true })
    .click();
  const logbook = page.getByRole("dialog", {
    name: `Logbook entry — ${ORDER}`,
    exact: true,
  });
  await expect(
    logbook.getByRole("button", { name: "Save as PDF", exact: true }),
  ).toBeDisabled();
  await enterLicense(logbook);
  const text = logbook.getByLabel("Logbook entry text", { exact: true });
  // Included cards contribute their log book line, actual work and signoff.
  await expect(text).toHaveValue(
    /Task #1 Seal check template: performed IAW Standard Practice found in AC43\.13/,
  );
  await expect(text).toHaveValue(/Work performed: Seal inspected/);
  await expect(text).toHaveValue(/Work signed by: Alex Morgan/);
  await expect(text).toHaveValue(/N206MA/);
  await expect(text).toHaveValue(/Next due:/);
  await expectInspectionTemplate(logbook, text);
  await expectComponentTemplate(logbook, text);

  const exported =
    (await text.inputValue()) +
    "\n" +
    "Additional review — José checked the record.\n".repeat(REVIEW_LINES) +
    "End of export";
  await text.fill(exported);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await logbook.getByRole("button", { name: "Copy text", exact: true }).click();
  await expect(logbook.getByRole("status")).toHaveText("Logbook entry copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    exported,
  );
  const pendingDownload = page.waitForEvent("download");
  await logbook
    .getByRole("button", { name: "Save as PDF", exact: true })
    .click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe(`${ORDER}-logbook.pdf`);
  const pdf = await readPdf(download);
  expect(pdf.pages).toBeGreaterThan(1);
  expect(pdf.text).toContain("CERT-12345");
  expect(pdf.text).toContain(
    "approved for return to service only for the work performed",
  );
  expect(pdf.text).toContain("José");
  expect(pdf.text).toContain("End of export");
  await page.goto("/inspections");
  await expect(source).toContainText("2,441.2 h");
  await source
    .getByRole("button", { name: "Job card templates (1)", exact: true })
    .click();
  await templates.getByRole("button", { name: SEAL_CHECK_CARD }).click();
  await expect(
    editor.getByLabel("Notes / remarks", { exact: true }),
  ).toHaveValue("Inspect seal condition");
});

/** Makes demo-insp-1 a 100-hour, 12-month inspection in every snapshot. */
async function storeInspectionInterval(page: Page) {
  const interval = { seconds: 100 * HOUR_SECONDS, months: 12 };
  await page.evaluate(async ({ seconds, months }) => {
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
      const state = entry.value;
      const inspection = state.inspections.find(
        (i: { uuid: string }) => i.uuid === "demo-insp-1",
      );
      inspection.intervalSeconds = seconds;
      inspection.intervalMonths = months;
      entry.update(state);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, interval);
}

/** Saves "Seal check template", included in the log book, on the inspection. */
async function createSealCheckTemplate(
  page: Page,
  source: Locator,
  templates: Locator,
) {
  await source
    .getByRole("button", { name: "Job card templates (0)", exact: true })
    .click();
  await templates
    .getByRole("button", { name: "Create job card template", exact: true })
    .click();
  const draft = page.getByRole("dialog", { name: "New job card", exact: true });
  await draft.getByLabel("Title", { exact: true }).fill("Seal check template");
  await draft
    .getByLabel("Notes / remarks", { exact: true })
    .fill("Inspect seal condition");
  // New cards are left out of the log book entry unless selected.
  await draft.getByLabel("Include in log book entry").check();
  await draft
    .getByRole("button", { name: "Save job card template", exact: true })
    .click();
}

/** Opens the order with demo-insp-1 as its existing work item. */
async function openOrderForInspection(page: Page) {
  await page.goto("/work-orders");
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const order = page.getByRole("dialog", {
    name: "Open work order",
    exact: true,
  });
  await order.getByLabel("Work order number").fill(ORDER);
  await order
    .getByLabel("Existing work item")
    .selectOption("inspection:demo-insp-1");
  await order
    .getByRole("button", { name: "Add selected work", exact: true })
    .click();
  await order
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(order).not.toBeVisible();
}

/** Records work on the order's copy, signs it as technician, completes it. */
async function signOffCopiedCard(editor: Locator) {
  await expect(editor.getByText(/Work-order copy of template/)).toBeVisible();
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("in-progress");
  await editor
    .getByLabel("Notes / remarks", { exact: true })
    .fill("No defects");
  await editor.getByLabel("Actual work performed").fill("Seal inspected");
  await editor.getByLabel("Completion date", { exact: true }).fill(localDate());
  await saveCardButton(editor).click();
  const technician = editor.getByRole("button", {
    name: "Technician signoff",
    exact: true,
  });
  await expect(technician).toBeEnabled();
  await technician.click();
  await expect(editor.getByText(/Technician: Alex Morgan/)).toBeVisible();
  // The technician cannot also give the independent inspection signoff.
  await expect(
    editor.getByRole("button", { name: "Inspection signoff", exact: true }),
  ).toBeDisabled();
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("completed");
  await saveCardButton(editor).click();
  await expect(saveCardButton(editor)).toBeDisabled();
  await closeDialog(editor);
}

/** Dismissing the closing warning keeps the order open; accepting closes it. */
async function closeOrderAfterConfirming(page: Page, details: Locator) {
  await details.getByLabel("Work order status").selectOption("completed");
  await details
    .getByLabel("Completion date", { exact: true })
    .fill(localDate());
  await details
    .getByLabel("Release outcome")
    .fill("Inspection complete; disposition reviewed.");
  await expect(details.getByRole("alert")).toContainText(
    "Closing this work order is permanent",
  );
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("no longer be able to modify");
    await dialog.dismiss();
  });
  await saveOrderButton(details).click();
  await expect(details).toBeVisible();
  await expect(saveOrderButton(details)).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await saveOrderButton(details).click();
  await expect(details).not.toBeVisible();
}

// The demo administrator has no approved certificate on file, so the entry
// is signed with a certificate typed for it.
async function enterLicense(logbook: Locator) {
  await expect(
    logbook.getByText(
      "A certificate you file under My certifications fills in here once an administrator has approved it.",
    ),
  ).toBeVisible();
  await logbook.getByLabel("License / certificate number").fill("CERT-12345");
  await logbook.getByLabel("Certificate type", { exact: true }).fill("A&P");
}

/**
 * The inspection template needs its checklist, AD/SB date and finding before
 * the airworthy statement and PDF appear; edited text survives template and
 * inspection-type changes.
 */
async function expectInspectionTemplate(logbook: Locator, text: Locator) {
  await chooseTemplate(logbook, "inspection");
  await expect(
    logbook.getByRole("button", { name: "Save as PDF" }),
  ).toBeDisabled();
  await expect(text).not.toHaveValue(
    /was determined to be in airworthy condition/,
  );
  await logbook
    .getByLabel("Manufacturer's inspection checklist")
    .fill("Cessna inspection checklist, revision 12");
  await logbook
    .getByLabel("AD / SB checked through")
    .fill("Bi-weekly Issue 26-20");
  await logbook.getByLabel("Inspection finding").selectOption("airworthy");
  await expect(text).toHaveValue(/14 CFR Part 43, Appendix D/);
  await expect(text).toHaveValue(
    /an annual inspection and was determined to be in airworthy condition/,
  );
  await expect(
    logbook.getByRole("button", { name: "Save as PDF" }),
  ).toBeEnabled();
  await text.fill((await text.inputValue()) + "\nFilter replaced; no leaks.");
  await logbook.getByLabel("Inspection type").selectOption("100-hour");
  await expect(text).toHaveValue(
    /a 100-hour inspection and was determined to be in airworthy condition/,
  );
  await expect(text).toHaveValue(/Filter replaced; no leaks/);
  await chooseTemplate(logbook, "maintenance");
  await expect(text).not.toHaveValue(/14 CFR Part 43, Appendix D/);
  await chooseTemplate(logbook, "inspection");
  await expect(text).toHaveValue(/Filter replaced; no leaks/);
}

/**
 * The component template needs a return-to-service outcome before copy or
 * PDF; each template keeps its own edited text.
 */
async function expectComponentTemplate(logbook: Locator, text: Locator) {
  const outcome = logbook.getByLabel("Return-to-service outcome");
  await chooseTemplate(logbook, "component");
  await expect(
    logbook.getByRole("button", { name: "Copy text", exact: true }),
  ).toBeDisabled();
  await expect(text).not.toHaveValue(
    /The aircraft is approved for return to service/,
  );
  await text.fill(
    (await text.inputValue()) +
      "\nReplacement filter P/N F-12, S/N SN-34; MM section 12.",
  );
  await outcome.selectOption("approved");
  await expect(text).toHaveValue(
    /The aircraft is approved for return to service only for the work performed/,
  );
  await expect(text).toHaveValue(/Replacement filter P\/N F-12/);
  await outcome.selectOption("");
  await expect(
    logbook.getByRole("button", { name: "Save as PDF" }),
  ).toBeDisabled();
  await expect(text).not.toHaveValue(
    /The aircraft is approved for return to service/,
  );
  await outcome.selectOption("approved");
  await chooseTemplate(logbook, "inspection");
  await expect(text).toHaveValue(/Filter replaced; no leaks/);
  await chooseTemplate(logbook, "component");
  await expect(text).toHaveValue(/Replacement filter P\/N F-12/);
}

/** Returns the page count and every page's text, items joined by spaces. */
async function readPdf(download: Download) {
  const task = getDocument({
    data: new Uint8Array(await readFile((await download.path())!)),
  });
  const pdf = await task.promise;
  let text = "";
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    text += content.items
      .flatMap((item) => ("str" in item ? [item.str] : []))
      .join(" ");
  }
  const pages = pdf.numPages;
  await task.destroy();
  return { pages, text };
}

function saveCardButton(editor: Locator): Locator {
  return editor.getByRole("button", { name: "Save job card", exact: true });
}

function saveOrderButton(details: Locator): Locator {
  return details.getByRole("button", { name: "Save work order", exact: true });
}

async function chooseTemplate(logbook: Locator, template: string) {
  await logbook.getByLabel("Logbook template").selectOption(template);
}

async function closeDialog(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
}
