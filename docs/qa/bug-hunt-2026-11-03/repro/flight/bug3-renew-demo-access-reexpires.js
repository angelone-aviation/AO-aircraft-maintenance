// flight-3: After the 7-day offline lease expires naturally (both cached demo
// snapshots carry the old authentication time), "Renew demo access" lets the
// user in, but the next synced change (logging a flight) drops them straight
// back to "Time to reconnect."
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  try {
    // Age the authentication time of every stored snapshot by 8 days (what 8 days of real time does).
    await L.patchSnapshot(page, "s.authenticatedAt = Date.now() - 8 * 86400000;");
    await page.getByRole("heading", { name: "Time to reconnect." }).waitFor();
    await page.getByRole("button", { name: "Renew demo access" }).click();
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
    const dialog = await L.openLogFlight(page, "N206MA");
    await dialog.getByLabel("Flight date & time").fill(await L.pageLocal(page, Date.now() - 3600000));
    await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
    await dialog.getByLabel("Origin", { exact: true }).fill("BUG3");
    await dialog.getByRole("button", { name: "Save flight", exact: true }).click();
    const expired = page.getByRole("heading", { name: "Time to reconnect." });
    const flightRow = page.getByRole("row").filter({ hasText: "BUG3" });
    await Promise.race([expired.waitFor(), flightRow.getByText("Accepted").waitFor()]);
    const bounced = await expired.isVisible();
    await page.screenshot({ path: L.SHOTS + "/bug3-after-log.png", fullPage: true });
    L.result(bounced, `"Renew demo access" does not stick: saving a flight right after renewing shows "Time to reconnect." again`);
  } catch (e) {
    console.error(e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
