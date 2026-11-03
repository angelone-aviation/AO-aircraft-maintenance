// Overview aircraft card / Maintenance outlook show hours remaining for an
// inspection whose calendar limit is overdue (status Overdue on Inspections).
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  let bug = false, msg = "";
  try {
    // Last compliance on the 1st of the month 13 months ago -> 12-month due date
    // falls at the end of last month (overdue today).
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 13, 1);
    const lastDate = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-01`;
    await page.getByRole("link", { name: "Inspections", exact: true }).click();
    await page.getByRole("button", { name: "New inspection" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Aircraft", { exact: true }).selectOption({ label: "N182MA" });
    await d.getByLabel("Reference", { exact: true }).fill("MX1 Annual + 100 h");
    await d.getByLabel("Description", { exact: true }).fill("Combined annual / 100-hour");
    await d.getByRole("checkbox", { name: "Hours", exact: true }).check();
    await d.getByRole("checkbox", { name: "Calendar", exact: true }).check();
    await d.getByLabel("Repeat every (hours)").fill("100");
    await d.getByLabel("Last complied at (tracked hours)").fill("1600");
    await d.getByLabel("Repeat every (months)").fill("12");
    await d.getByLabel("Last compliance date").fill(lastDate);
    await d.getByRole("button", { name: "Save inspection" }).click();
    await d.waitFor({ state: "hidden" });
    const row = page.getByRole("row").filter({ hasText: "MX1 Annual + 100 h" });
    const rowText = (await row.innerText()).replace(/\n/g, " | ");
    console.log("Inspections row:", rowText);
    await page.waitForTimeout(800);
    await page.screenshot({ path: L.SHOTS + "/mx-1-inspections.png", fullPage: true });

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    const card = page.locator(".dash-card").filter({ hasText: "N182MA" });
    await card.waitFor();
    await page.waitForTimeout(1500);
    const cardText = (await card.innerText()).replace(/\n/g, " | ");
    console.log("Overview card:", cardText);
    const outlook = page.locator(".dash-outlook-row").filter({ hasText: "MX1 Annual + 100 h" });
    const outlookText = (await outlook.innerText()).replace(/\n/g, " | ");
    console.log("Outlook row:", outlookText);
    await page.screenshot({ path: L.SHOTS + "/mx-1-overview.png", fullPage: true });

    const listOverdue = /Overdue/.test(rowText) && /days? overdue/.test(rowText);
    const cardShowsHoursRemaining = /MX1 Annual \+ 100 h \| 49\.6 h remaining \| Last 1,600\.0 h \| Due 1,700\.0 h/.test(cardText);
    const outlookShowsHours = /49\.6 h/.test(outlookText) && !/overdue/i.test(outlookText);
    if (listOverdue && (cardShowsHoursRemaining || outlookShowsHours)) {
      bug = true;
      msg = `Inspections list: "2 days overdue"/Overdue; Overview N182MA card shows "${cardShowsHoursRemaining ? "49.6 h remaining (Due 1,700.0 h)" : "-"}", outlook shows "${outlookText.split(" | ").pop()}" with no calendar overdue`;
    }
  } finally {
    await browser.close();
  }
  L.result(bug, msg);
})();
