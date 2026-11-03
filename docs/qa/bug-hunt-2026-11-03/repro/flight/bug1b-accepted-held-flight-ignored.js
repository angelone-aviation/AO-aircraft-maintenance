// flight-1 (variant): a flight held because it "predates an aircraft counter
// change" is accepted by an administrator, yet its hours and landings never
// reach the aircraft totals.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  try {
    // 1. Administrator enables the Flight time log option on N206MA (counter event at "now").
    await page.goto(L.BASE + "/aircraft");
    const row = page.getByRole("list", { name: "Aircraft", exact: true }).getByRole("listitem").filter({ hasText: "N206MA" });
    await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Flight time log", { exact: true }).check();
    await dialog.getByLabel("Current Flight time log (hours)").fill("100");
    await dialog.getByRole("button", { name: "Save aircraft", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // 2. Pilot logs this morning's flight (3 h ago): Hobbs 2341.2 -> 2342.5, 2 landings.
    dialog = await L.openLogFlight(page, "N206MA");
    await dialog.getByLabel("Flight date & time").fill(await L.pageLocal(page, Date.now() - 3 * 3600000));
    await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.5");
    await dialog.getByLabel("Landings", { exact: true }).fill("2");
    await dialog.getByLabel("Origin", { exact: true }).fill("BUG1B");
    await dialog.getByRole("button", { name: "Save flight", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const flightRow = page.getByRole("row").filter({ hasText: "BUG1B" });
    await flightRow.getByText("Needs review").waitFor();
    // 3. Administrator accepts it.
    await flightRow.getByRole("button", { name: "Review", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Review decision").selectOption("accept");
    await dialog.getByLabel("Explanation", { exact: true }).fill("Verified against the pilot's paper log");
    await dialog.getByRole("button", { name: "Record review", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await flightRow.getByText("Accepted").waitFor();
    console.log("flight row:", (await flightRow.innerText()).replace(/\s+/g, " "));
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    const card = page.locator(".dash-card").filter({ hasText: "N206MA" });
    await card.waitFor();
    await page.screenshot({ path: L.SHOTS + "/bug1b-overview.png", fullPage: true });
    const meters = (await card.locator(".dash-meters").innerText()).replace(/\s+/g, " ");
    console.log("N206MA card:", meters);
    const bug = !/HOBBS 2342\.5/i.test(meters) || !/LANDINGS 2,196/i.test(meters);
    L.result(bug, `accepted flight (Hobbs 2341.2->2342.5, 2 landings) not in totals: card shows "${meters}" (expected Hobbs 2342.5, landings 2,196)`);
  } catch (e) {
    console.error(e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
