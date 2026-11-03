// A life-limited component exactly at its limit (0 h remaining) is "Action
// required / Component due now" in Alerts, but the aircraft status is only
// "Due soon" and a flight can be logged with no dispatch override. An aircraft
// inspection at exactly 0 h remaining is Overdue and grounds its aircraft.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  let bug = false, msg = "";
  try {
    await L.patchSnapshot(page, `
      const a = s.aircraft.find((x) => x.uuid === "demo-206");
      const total = a.currentHobbs + a.adjustmentSeconds;
      // N206MA: drop the seeded 100-hour so only the component drives status.
      s.inspections = s.inspections.filter((i) => i.aircraftUuid !== "demo-206");
      // N208MA: an inspection exactly at its hour limit, for comparison.
      const b = s.aircraft.find((x) => x.uuid === "demo-208");
      s.inspections = s.inspections.map((i) => i.uuid === "demo-insp-3" ? { ...i, dueSeconds: b.currentHobbs + b.adjustmentSeconds } : i);
      s.management = [...(s.management || []).filter((r) => r.uuid !== "mx4-prop" && r.uuid !== "mx4-life"), {
        uuid: "mx4-prop", version: 1, kind: "component", programUuid: "demo-program",
        aircraftUuid: a.uuid, componentType: "Propeller", partNumber: "PN-PROP", serial: "SN-MX4",
        manufacturer: "", notes: "", installed: true, installedDate: "2026-01-01", installPosition: "MAIN",
        installedSeconds: total - 36000, installedCycles: a.cycles - 10,
        timeSinceNew: 100 * 3600, timeSinceOverhaul: null, timeSinceRepair: null,
        cyclesSinceNew: 30, serviceDaysBase: 0, trackTime: true, trackCycles: true, trackCalendar: true,
      }, {
        uuid: "mx4-life", version: 1, kind: "componentRequirement", programUuid: "demo-program",
        aircraftUuid: a.uuid, componentUuid: "mx4-prop", requirementType: "Life Limits",
        description: "Blade life limit 110 h TSN", notes: "", calendarIntervalUnit: "MONTHS",
        timeBasis: "TSN", timeLimitMode: "ABSOLUTE", cycleLimitMode: "ABSOLUTE",
        dueSeconds: 110 * 3600, warningCalendarMonths: 0, warningSeconds: 36000, warningCycles: 0,
      }];
    `);
    await page.getByRole("heading", { name: "Your fleet, at a glance." }).waitFor();
    await page.waitForTimeout(1500);
    const c206 = (await page.locator(".dash-card").filter({ hasText: "N206MA" }).innerText()).replace(/\n/g, " | ");
    const c208 = (await page.locator(".dash-card").filter({ hasText: "N208MA" }).innerText()).replace(/\n/g, " | ");
    console.log("N206MA card:", c206);
    console.log("N208MA card:", c208);
    await page.screenshot({ path: L.SHOTS + "/mx-4-overview.png", fullPage: true });

    // Components screen
    await page.getByRole("link", { name: "Components", exact: true }).click();
    await page.waitForTimeout(1000);
    const compRow = (await page.getByRole("row").filter({ hasText: "SN-MX4" }).first().innerText()).replace(/\n/g, " | ");
    console.log("Components row:", compRow);

    // Alerts
    await page.getByRole("link", { name: /^Alerts \d/ }).first().click();
    await page.waitForTimeout(1000);
    const alertsText = (await page.locator("body").innerText()).replace(/\n/g, " | ");
    console.log("Alerts:", alertsText.slice(0, 1200));
    await page.screenshot({ path: L.SHOTS + "/mx-4-alerts.png", fullPage: true });
    const alertDanger = /Action required.*Component due now: Propeller/.test(alertsText);

    // Log a flight on N206MA: does the dispatch gate ask for an override?
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page.locator(".dash-card").filter({ hasText: "N206MA" }).getByRole("button", { name: /Log flight/ }).click();
    const fd = page.getByRole("dialog");
    await fd.waitFor();
    await page.waitForTimeout(500);
    const formText = (await fd.innerText()).replace(/\n/g, " | ");
    const asksOverride = /grounded/i.test(formText);
    console.log("Flight form mentions grounded/override:", asksOverride);
    await page.screenshot({ path: L.SHOTS + "/mx-4-flight-form.png", fullPage: true });

    const comp206DueSoon = /N206MA \| Due soon/.test(c206);
    const insp208Grounded = /N208MA \| Grounded/.test(c208);
    if (alertDanger && comp206DueSoon && !asksOverride && insp208Grounded) {
      bug = true;
      msg = "Propeller at its 110 h TSN life limit: Alerts 'Action required', but N206MA status 'Due soon' and flight logging needs no override (inspection at 0 h on N208MA = Grounded)";
    }
  } finally {
    await browser.close();
  }
  L.result(bug, msg);
})();
