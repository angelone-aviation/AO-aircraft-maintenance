// A recurring AD action with an initial calendar due date and an hour-based
// repeat stays Overdue (and grounds the aircraft) after compliance is recorded,
// because the initial due date is never cleared or advanced.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  let bug = false, msg = "";
  try {
    const yesterday = L.shiftDays(-1);
    await page.getByRole("link", { name: "Airworthiness directives", exact: true }).click();
    await page.getByRole("button", { name: "Add AD", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("AD number", { exact: true }).fill("2026-03-03");
    await dialog.getByLabel("Subject", { exact: true }).fill("MX3 initial within date, repeat every 100 h");
    await dialog.getByLabel("Applicability", { exact: true }).selectOption("Applicable");
    await dialog.getByLabel("Applicability and source changes reviewed").check();
    await dialog.getByRole("button", { name: "Add required action" }).click();
    await dialog.getByLabel("Required action", { exact: true }).fill("Inspect elevator hinge; repeat every 100 hours");
    await dialog.getByLabel("Action recurrence").selectOption("Recurring");
    await dialog.getByRole("checkbox", { name: "Calendar", exact: true }).check();
    await dialog.getByLabel("Next due date").fill(yesterday);
    await dialog.getByRole("checkbox", { name: "Hours", exact: true }).check();
    await dialog.getByLabel("Next due hours").fill("2400");
    await dialog.getByLabel("Repeat every hours").fill("100");
    await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".ad-register-group > summary").first().click();
    console.log("Before compliance overdue:", await page.getByText("Overdue", { exact: true }).count());

    await page.getByRole("button", { name: "Details for AD 2026-03-03" }).click();
    await page.getByRole("button", { name: "Record compliance", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Hours at completion").fill("2341.2");
    await dialog.getByLabel("Method of compliance").fill("Inspected hinge; no defects");
    await dialog.getByRole("button", { name: "Save compliance" }).click();
    await page.getByRole("dialog", { name: /Record compliance/i }).waitFor({ state: "hidden" }).catch(() => {});
    await page.waitForTimeout(800);
    const details = page.getByRole("dialog");
    const detailText = (await details.innerText().catch(() => "")).replace(/\n/g, " | ");
    console.log("Details after compliance:", detailText.slice(0, 1500));
    await page.screenshot({ path: L.SHOTS + "/mx-3-ad-details.png", fullPage: true });
    if (await details.count()) await details.getByRole("button", { name: "Close dialog", exact: true }).click().catch(() => {});
    await page.reload();
    await page.locator(".ad-register-group > summary").first().click();
    const row = page.getByRole("row").filter({ hasText: "2026-03-03" });
    const rowText = (await row.first().innerText()).replace(/\n/g, " | ");
    console.log("Register row after compliance:", rowText);
    await page.screenshot({ path: L.SHOTS + "/mx-3-ad-register.png", fullPage: true });
    // Aircraft status on Overview
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    const card = page.locator(".dash-card").filter({ hasText: "N206MA" });
    await card.waitFor();
    await page.waitForTimeout(1200);
    const cardText = (await card.innerText()).replace(/\n/g, " | ");
    console.log("N206MA card:", cardText);
    await page.screenshot({ path: L.SHOTS + "/mx-3-overview.png", fullPage: true });
    const snaps = await L.readSnapshot(page);
    const ad = snaps[0].airworthiness.find((r) => r.source.number === "2026-03-03");
    console.log("Stored task:", JSON.stringify(ad.tasks[0]), "history:", ad.history.length);
    if (ad.history.length === 1 && /Overdue/.test(rowText) && /AD 2026-03-03 overdue/.test(cardText)) {
      bug = true;
      msg = `After recording compliance at 2341.2 h (next due 2441.2 h), AD still Overdue on stale initial date ${ad.tasks[0].dueDate} and N206MA stays Grounded`;
    }
  } finally {
    await browser.close();
  }
  L.result(bug, msg);
})();
