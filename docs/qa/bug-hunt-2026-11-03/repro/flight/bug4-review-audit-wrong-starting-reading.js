// flight-4: Accepting a backdated flight records a change-history "after"
// value with the wrong starting Hobbs, and the later flight's starting Hobbs
// is rewritten with no change-history entry at all.
const L = require("./lib");
async function log(page, ending, minsAgo, origin) {
  const dialog = await L.openLogFlight(page, "N206MA");
  await dialog.getByLabel("Flight date & time").fill(await L.pageLocal(page, Date.now() - minsAgo * 60000));
  await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill(ending);
  await dialog.getByLabel("Origin", { exact: true }).fill(origin);
  await dialog.getByRole("button", { name: "Save flight", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
(async () => {
  const { browser, page } = await L.start();
  try {
    await log(page, "2342.2", 60, "LATER");        // accepted, 2341.2 -> 2342.2
    await log(page, "2341.7", 180, "EARLIER");     // backdated -> Needs review
    const earlier = page.getByRole("row").filter({ hasText: "EARLIER" });
    await earlier.getByRole("button", { name: "Review", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Explanation", { exact: true }).fill("Late entry verified against the paper log");
    await dialog.getByRole("button", { name: "Record review", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await earlier.getByText("Accepted").waitFor();
    const savedEarlier = (await earlier.innerText()).replace(/\s+/g, " ");
    const savedLater = (await page.getByRole("row").filter({ hasText: "LATER" }).innerText()).replace(/\s+/g, " ");
    console.log("EARLIER row:", savedEarlier);
    console.log("LATER row:", savedLater);
    await page.getByRole("link", { name: "Change history", exact: true }).click();
    const entry = page.locator(".rec-entry").filter({ hasText: "Late entry verified against the paper log" });
    await entry.getByText("View recorded values").click();
    const after = JSON.parse(await entry.locator(".rec-audit-values > div").nth(1).locator("pre").innerText());
    await page.screenshot({ path: L.SHOTS + "/bug4-history.png", fullPage: true });
    const afterStart = after.hobbsOff / 3600;
    console.log(`change history "after": starting Hobbs ${afterStart.toFixed(1)}, ending ${(after.hobbsOn / 3600).toFixed(1)}; flight log shows starting 2,341.2`);
    const laterEntries = await page.locator(".rec-entry").filter({ hasText: "Flight · reviewed" }).count();
    console.log("flight.reviewed entries:", laterEntries, "(only the EARLIER flight; LATER's start changed 2,341.2 -> 2,341.7 unaudited)");
    const bug = Math.abs(afterStart - 2341.2) > 0.01 && /2,341\.7 from 2,341\.2/.test(savedEarlier);
    L.result(bug, `change history records starting Hobbs ${afterStart.toFixed(1)} for the accepted flight, but the saved record starts at 2,341.2`);
  } catch (e) {
    console.error(e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
