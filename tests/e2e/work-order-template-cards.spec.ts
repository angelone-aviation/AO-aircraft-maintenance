import { readFile } from "node:fs/promises";
import { localDate } from "../../src/domain/model";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { test, expect } from "@playwright/test";
import { expandTask } from "../fixtures/workOrderTasks";
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
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readwrite");
        const cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const state = entry.value;
          const inspection = state.inspections.find(
            (i: { uuid: string }) => i.uuid === "demo-insp-1",
          );
          inspection.intervalSeconds = 360000;
          inspection.intervalMonths = 12;
          entry.update(state);
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();

  const source = page
    .getByRole("row")
    .filter({ hasText: "100-hour inspection" })
    .filter({ hasText: "N206MA" });
  await source
    .getByRole("button", { name: "Job card templates (0)", exact: true })
    .click();
  const templates = page.getByRole("dialog", {
    name: "Linked job card templates",
    exact: true,
  });
  await templates
    .getByRole("button", { name: "Create job card template", exact: true })
    .click();
  let editor = page.getByRole("dialog", { name: "New job card", exact: true });
  await editor.getByLabel("Title", { exact: true }).fill("Seal check template");
  await editor
    .getByLabel("Notes / remarks", { exact: true })
    .fill("Inspect seal condition");
  // New cards are left out of the log book entry unless selected.
  await editor.getByLabel("Include in log book entry").check();
  await editor
    .getByRole("button", { name: "Save job card template", exact: true })
    .click();
  editor = page.getByRole("dialog", { name: /Job card TC-/ });
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Technician signoff", exact: true }),
  ).toHaveCount(0);
  await page.goto("/work-orders");
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const order = page.getByRole("dialog", {
    name: "Open work order",
    exact: true,
  });
  await order.getByLabel("Work order number").fill("WO-TEMPLATE-COPY");
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
  const orderRow = page
    .getByRole("row")
    .filter({ hasText: "WO-TEMPLATE-COPY" });
  await orderRow.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "WO-TEMPLATE-COPY",
    exact: true,
  });
  await expandTask(details, 1);
  await expect(
    details.getByLabel("Task 1 status").locator('option[value="completed"]'),
  ).toBeDisabled();
  // Each task's job cards are a collapsible group.
  const nestedCards = details.getByRole("group", {
    name: "Job cards for 100-hour inspection: Airframe and engine inspection",
    exact: true,
  });
  await expect(nestedCards.locator("> summary")).toHaveText("Job cards (1)");
  await nestedCards.locator("> summary").click();
  await expect(nestedCards).toContainText("Technician: Pending");
  await nestedCards
    .getByRole("button", { name: /TC-.*Seal check template/ })
    .click();
  editor = page.getByRole("dialog", { name: /Job card TC-/ });
  await expect(editor.getByText(/Work-order copy of template/)).toBeVisible();
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("in-progress");
  await editor
    .getByLabel("Notes / remarks", { exact: true })
    .fill("No defects");
  await editor.getByLabel("Actual work performed").fill("Seal inspected");
  await editor.getByLabel("Completion date", { exact: true }).fill(localDate());
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Technician signoff", exact: true }),
  ).toBeEnabled();
  await editor
    .getByRole("button", { name: "Technician signoff", exact: true })
    .click();
  await expect(editor.getByText(/Technician: Alex Morgan/)).toBeVisible();
  // The technician cannot also give the independent inspection signoff.
  await expect(
    editor.getByRole("button", { name: "Inspection signoff", exact: true }),
  ).toBeDisabled();
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("completed");
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Save job card", exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(nestedCards).toContainText("Technician: Signed");
  await expect(
    details.getByLabel("Task 1 status").locator('option[value="completed"]'),
  ).toBeEnabled();
  await details.getByLabel("Task 1 status").selectOption("completed");
  await details
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(details).not.toBeVisible();
  await orderRow.getByRole("button", { name: "Details", exact: true }).click();
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
  await details
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(details).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Save work order", exact: true }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());

  await details
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(details).not.toBeVisible();
  await page.getByLabel("Include closed work orders").check();
  await orderRow.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    details.getByText("1 inspection compliance record(s) updated at closeout."),
  ).toBeVisible();
  await expandTask(details, 1);
  await nestedCards.locator("> summary").click();
  await nestedCards
    .getByRole("button", { name: /TC-.*Seal check template/ })
    .click();
  editor = page.getByRole("dialog", { name: /Job card TC-/ });
  await expect(
    editor.getByLabel("Actual work performed", { exact: true }),
  ).toHaveValue("Seal inspected");
  await expect(
    editor.getByRole("button", { name: "Save job card", exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await details
    .getByRole("button", { name: "Generate logbook entry", exact: true })
    .click();
  const logbook = page.getByRole("dialog", {
    name: "Logbook entry — WO-TEMPLATE-COPY",
    exact: true,
  });
  await expect(
    logbook.getByRole("button", { name: "Save as PDF", exact: true }),
  ).toBeDisabled();
  await logbook.getByLabel("License / certificate number").fill("CERT-12345");
  await logbook.getByLabel("Certificate type", { exact: true }).fill("A&P");
  await logbook
    .getByRole("button", { name: "Save license to my profile", exact: true })
    .click();
  await expect(logbook.getByRole("status")).toHaveText(
    "License saved to your profile.",
  );
  const text = logbook.getByLabel("Logbook entry text", { exact: true });
  // Included cards contribute their log book line, actual work and signoff.
  await expect(text).toHaveValue(
    /Task #1 Seal check template: performed IAW Standard Practice found in AC43\.13/,
  );
  await expect(text).toHaveValue(/Work performed: Seal inspected/);
  await expect(text).toHaveValue(/Work signed by: Alex Morgan/);
  await expect(text).toHaveValue(/N206MA/);
  await expect(text).toHaveValue(/Next due:/);
  await logbook.getByLabel("Logbook template").selectOption("inspection");
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
  await logbook.getByLabel("Logbook template").selectOption("maintenance");
  await expect(text).not.toHaveValue(/14 CFR Part 43, Appendix D/);
  await logbook.getByLabel("Logbook template").selectOption("inspection");
  await expect(text).toHaveValue(/Filter replaced; no leaks/);

  await logbook.getByLabel("Logbook template").selectOption("component");
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
  await logbook
    .getByLabel("Return-to-service outcome")
    .selectOption("approved");
  await expect(text).toHaveValue(
    /The aircraft is approved for return to service only for the work performed/,
  );
  await expect(text).toHaveValue(/Replacement filter P\/N F-12/);
  await logbook.getByLabel("Return-to-service outcome").selectOption("");
  await expect(
    logbook.getByRole("button", { name: "Save as PDF" }),
  ).toBeDisabled();
  await expect(text).not.toHaveValue(
    /The aircraft is approved for return to service/,
  );
  await logbook
    .getByLabel("Return-to-service outcome")
    .selectOption("approved");
  await logbook.getByLabel("Logbook template").selectOption("inspection");
  await expect(text).toHaveValue(/Filter replaced; no leaks/);
  await logbook.getByLabel("Logbook template").selectOption("component");
  await expect(text).toHaveValue(/Replacement filter P\/N F-12/);

  const exported =
    (await text.inputValue()) +
    "\n" +
    "Additional review — José checked the record.\n".repeat(85) +
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
  expect(download.suggestedFilename()).toBe("WO-TEMPLATE-COPY-logbook.pdf");
  const pdfTask = getDocument({
    data: new Uint8Array(await readFile((await download.path())!)),
  });
  const pdf = await pdfTask.promise;
  expect(pdf.numPages).toBeGreaterThan(1);
  let pdfText = "";
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pdfText += content.items
      .flatMap((item) => ("str" in item ? [item.str] : []))
      .join(" ");
  }
  expect(pdfText).toContain("CERT-12345");
  expect(pdfText).toContain(
    "approved for return to service only for the work performed",
  );
  expect(pdfText).toContain("José");
  expect(pdfText).toContain("End of export");
  await pdfTask.destroy();
  await page.goto("/inspections");
  await expect(source).toContainText("2,441.2 h");
  await source
    .getByRole("button", { name: "Job card templates (1)", exact: true })
    .click();
  await templates
    .getByRole("button", { name: /TC-.*Seal check template/ })
    .click();
  editor = page.getByRole("dialog", { name: /Job card TC-/ });
  await expect(
    editor.getByLabel("Notes / remarks", { exact: true }),
  ).toHaveValue("Inspect seal condition");
});
