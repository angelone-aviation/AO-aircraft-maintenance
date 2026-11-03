// Editing an AD's required-action due limit clears an Overdue AD, but the change
// history records no before/after values (or reason) for the edit.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  let bug = false, msg = "";
  try {
    await page.getByRole("link", { name: "Airworthiness directives", exact: true }).click();
    await page.getByRole("button", { name: "Add AD", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("AD number", { exact: true }).fill("2026-09-09");
    await dialog.getByLabel("Subject", { exact: true }).fill("MX2 inspect fittings");
    await dialog.getByLabel("Applicability", { exact: true }).selectOption("Applicable");
    await dialog.getByLabel("Applicability and source changes reviewed").check();
    await dialog.getByRole("button", { name: "Add required action" }).click();
    await dialog.getByLabel("Required action", { exact: true }).fill("Inspect fittings per paragraph (g)");
    await dialog.getByLabel("Action recurrence").selectOption("One-time");
    await dialog.getByRole("checkbox", { name: "Hours", exact: true }).check();
    await dialog.getByLabel("Next due hours").fill("2300");
    await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".ad-register-group > summary").first().click();
    const overdueBefore = await page.getByText("Overdue", { exact: true }).first().isVisible();
    console.log("AD overdue after creation:", overdueBefore);

    // Edit the due limit so the overdue AD becomes scheduled.
    await page.getByRole("button", { name: "Review / edit AD" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Next due hours").fill("3000");
    // Since #21, changing a decided AD requires a reason (absent before the fix).
    const reason = dialog.getByLabel("Reason for change");
    if (await reason.count()) await reason.fill("Corrected next due hours per AD revision");
    await dialog.getByRole("button", { name: "Save AD", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForTimeout(500);
    const overdueAfter = await page.getByText("Overdue", { exact: true }).count();
    console.log("Overdue labels after edit:", overdueAfter);

    // Change history for N206MA
    await page.getByRole("link", { name: "Change history", exact: true }).click();
    await page.getByRole("heading", { name: "Change history" }).waitFor();
    await page.waitForTimeout(800);
    const entries = page.locator(".rec-entry").filter({ hasText: /Ad · save/ });
    const n = await entries.count();
    const texts = [];
    for (let i = 0; i < n; i++) texts.push((await entries.nth(i).innerText()).replace(/\n/g, " | "));
    console.log("AD history entries:", JSON.stringify(texts, null, 1));
    const withValues = await entries.filter({ hasText: "View recorded values" }).count();
    await page.screenshot({ path: L.SHOTS + "/mx-2-history.png", fullPage: false });
    // Also inspect the stored audit entries directly.
    const snaps = await L.readSnapshot(page);
    const audit = snaps.flatMap((s) => (s.audit || []).filter((a) => a.action === "ad.save"));
    console.log("Stored ad.save audit:", JSON.stringify(audit.map(({ action, reason, before, after }) => ({ action, reason, before, after }))));
    const anyBeforeWith2300 = audit.some((a) => a.before && a.before.includes("2300"));
    if (overdueBefore && overdueAfter === 0 && n >= 2 && withValues === 0 && !anyBeforeWith2300) {
      bug = true;
      msg = `AD due limit edited 2300 h -> 3000 h (Overdue cleared); ${n} "Ad · save" history entries carry no before/after values or reason`;
    }
  } finally {
    await browser.close();
  }
  L.result(bug, msg);
})();
