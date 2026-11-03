// flight-1: After any aircraft counter event (here: enabling the Flight time log
// option), correcting or rejecting an earlier accepted flight is recorded but
// never reaches aircraft totals.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  try {
    // 1. Log a flight on N206MA: Hobbs 2341.2 -> 2342.2, 1 landing.
    let dialog = await L.openLogFlight(page, "N206MA");
    await dialog.getByLabel("Flight date & time").fill(await L.pageLocal(page, Date.now() - 3 * 3600000));
    await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
    await dialog.getByLabel("Landings", { exact: true }).fill("1");
    await dialog.getByLabel("Origin", { exact: true }).fill("BUG1");
    await dialog.getByRole("button", { name: "Save flight", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // 2. Administrator enables the Flight time log option (records a counter event).
    await page.goto(L.BASE + "/aircraft");
    const row = page.getByRole("list", { name: "Aircraft", exact: true }).getByRole("listitem").filter({ hasText: "N206MA" });
    await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Flight time log", { exact: true }).check();
    await dialog.getByLabel("Current Flight time log (hours)").fill("100");
    await dialog.getByRole("button", { name: "Save aircraft", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // 3. Correct the flight: Hobbs ending 2342.2 -> 2342.6, landings 1 -> 3.
    await page.goto(L.BASE + "/flights");
    const flightRow = page.getByRole("row").filter({ hasText: "BUG1" });
    await flightRow.getByRole("button", { name: "Correct", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.6");
    await dialog.getByLabel("Landings", { exact: true }).fill("3");
    await dialog.getByLabel("Review decision").selectOption("accept");
    await dialog.getByLabel("Explanation", { exact: true }).fill("Paper log shows 2342.6 and two touch-and-goes");
    await dialog.getByRole("button", { name: "Record review", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await flightRow.getByText("2,342.6").waitFor();
    const rowText = (await flightRow.innerText()).replace(/\s+/g, " ");
    // 4. Read aircraft totals from the Overview card.
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    const card = page.locator(".dash-card").filter({ hasText: "N206MA" });
    await card.waitFor();
    await page.screenshot({ path: L.SHOTS + "/bug1-overview.png", fullPage: true });
    const meters = await card.locator(".dash-meters").innerText();
    const get = (label) => meters.split("\n").map((s) => s.trim()).filter(Boolean)
      .reduce((v, s, i, arr) => (s.toUpperCase() === label ? arr[i + 1] : v), "");
    const hobbs = get("HOBBS"), landings = get("LANDINGS"), total = get("TOTAL");
    console.log("flight row:", rowText);
    console.log(`Overview card: total=${total} hobbs=${hobbs} landings=${landings} (expected hobbs 2342.6, landings 2,197)`);
    const bug = hobbs !== "2342.6" || landings !== "2,197";
    L.result(bug, `accepted correction (Hobbs end 2342.6, 3 landings) not applied to totals after Flight time log was enabled: card shows Hobbs ${hobbs}, landings ${landings} (expected 2342.6 / 2,197)`);
  } catch (e) {
    console.error(e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
