// flight-2: Switching aircraft in a new-flight form keeps the ending Hobbs/tach
// typed for the previous aircraft; saving records them against the new one.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  try {
    const dialog = await L.openLogFlight(page, "N206MA");
    await dialog.getByLabel("Flight date & time").fill(await L.pageLocal(page, Date.now() - 3600000));
    // Readings for N206MA (starting Hobbs 2341.2, tach 2261.2).
    await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
    await dialog.getByLabel("Ending tach", { exact: true }).fill("2262.0");
    await dialog.getByLabel("Origin", { exact: true }).fill("BUG2");
    // Switch to N182MA (starting Hobbs 1650.4).
    const sel = dialog.getByLabel("Aircraft", { exact: true });
    await sel.selectOption((await sel.locator("option").filter({ hasText: "N182MA" }).getAttribute("value")));
    await dialog.getByLabel("Starting Hobbs (hours)").evaluate((el) => el.value === "1650.4" || Promise.reject("not switched"));
    const endHobbs = await dialog.getByLabel("Ending Hobbs *", { exact: true }).inputValue();
    const endTach = await dialog.getByLabel("Ending tach", { exact: true }).inputValue();
    const strip = (await dialog.locator(".flight-delta strong").innerText()).trim();
    await page.screenshot({ path: L.SHOTS + "/bug2-switched.png", fullPage: true });
    console.log(`after switching to N182MA: ending Hobbs="${endHobbs}" ending tach="${endTach}" strip="${strip}"`);
    const bug = endHobbs !== "" || endTach !== "";
    // Once fixed, the required ending Hobbs is empty and the form cannot be saved as is.
    if (bug) {
      await dialog.getByRole("button", { name: "Save flight", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const row = page.getByRole("row").filter({ hasText: "BUG2" });
      await row.waitFor();
      console.log("flight row:", (await row.innerText()).replace(/\s+/g, " "));
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      const card = page.locator(".dash-card").filter({ hasText: "N182MA" });
      await card.waitFor();
      console.log("N182MA card:", (await card.locator(".dash-meters").innerText()).replace(/\s+/g, " "));
    }
    L.result(bug, `ending Hobbs ${endHobbs} / tach ${endTach} typed for N206MA carried over after switching to N182MA (strip "${strip}") and were saved against N182MA`);
  } catch (e) {
    console.error(e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
