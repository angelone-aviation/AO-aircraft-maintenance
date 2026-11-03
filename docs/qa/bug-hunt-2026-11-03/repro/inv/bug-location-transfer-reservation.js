// Transferring a storage location to another Flight Program carries stock that is
// reserved for a parts request in the source program; the reservation can then be
// neither issued nor released, and the destination stock stays locked.
const { start, go, seed, loc, stock, snapshot, result } = require("./lib");
const { requestFromStock, openRequest, requestAction } = require("./reqlib");
(async () => {
  const { browser, page } = await start();
  try {
    await seed(page, [{ ...loc("L1", "Main hangar"), address: "1 Hangar Rd" }, stock("S1", "L1", "FILTER-1", { description: "Oil filter", quantity: 5 })],
      `s.programs = [...s.programs, { uuid: "p2", version: 1, name: "Second program", address: "", email: "", contactName: "", website: "" }];`);
    await requestFromStock(page, "FILTER-1", 3);
    let rd = await openRequest(page, "PR-00001");
    await requestAction(page, rd, "reserve", "S1", 3);
    await rd.getByText("Reserved 3 · Issued 0").waitFor();
    console.log("Reserved 3 of FILTER-1 on PR-00001");
    // Transfer the storage location (System administrator, Flight Programs page).
    await go(page, "/programs");
    const t = page.locator("section[aria-labelledby=ops-transfer-title]");
    await t.getByLabel("Record type").selectOption("location");
    await t.getByLabel("Record to transfer").selectOption("L1");
    await t.getByLabel("Destination Flight Program").selectOption("p2");
    await t.getByLabel("Transfer reason").fill("Base consolidation");
    await t.getByRole("button", { name: "Transfer record" }).click();
    // Since the #48 fix the transfer is refused while stock is reserved.
    const refused = await Promise.race([
      page.getByText("Record transferred to its destination Flight Program.").waitFor().then(() => ""),
      t.getByRole("alert").waitFor().then(() => t.getByRole("alert").innerText()),
    ]);
    if (refused) {
      const kept = (await snapshot(page))[0].management.find((r) => r.uuid === "S1");
      console.log("Transfer refused:", refused.trim(), "| stock S1 stays in", kept.programUuid, "reserved", kept.reservedQuantity);
      return result(kept.programUuid !== "demo-program", "location transfer was refused but its stock moved anyway");
    }
    console.log("Location transferred without error");
    // Source program: the request still holds the reservation but cannot use or release it.
    rd = await openRequest(page, "PR-00001");
    const progress = await rd.locator(".request-line p").first().innerText();
    await rd.getByLabel("Inventory action").selectOption("release");
    const options = await rd.getByLabel("Stock lot / location").locator("option").allInnerTexts();
    console.log("Request after transfer:", progress, "| release options:", options.join(" / "));
    let releaseError = "";
    if (options.length > 1) {
      await requestAction(page, rd, "release", "S1", 3);
      releaseError = (await rd.getByRole("alert").innerText()).trim();
    } else releaseError = "no stock lot can be selected for release";
    console.log("Release attempt:", releaseError);
    await page.screenshot({ path: "bug-location-transfer-reservation.png" });
    // Destination program: stock still carries the reservation from the other program.
    await page.getByLabel("Active Flight Program").first().selectOption("p2");
    await go(page, "/inventory");
    const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
    await row.waitFor();
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    console.log("Second program inventory row:", rowText.slice(0, 160));
    // Try to count the stock down to zero in the destination program.
    await row.getByRole("button", { name: "Move stock" }).click();
    const move = page.getByRole("dialog", { name: "Stock movement" });
    await move.getByLabel("Movement type").selectOption("adjust");
    await move.getByLabel("Quantity (counted balance for adjustment)").fill("0");
    await move.getByRole("button", { name: "Save" }).click();
    const adjustError = (await move.getByRole("alert").innerText()).trim();
    console.log("Adjust to 0 in destination:", adjustError);
    await page.screenshot({ path: "bug-location-transfer-reservation-dest.png" });
    const s = (await snapshot(page))[0];
    const moved = s.management.find((r) => r.uuid === "S1");
    console.log("Stock S1 now in", moved.programUuid, "quantity", moved.quantity, "reserved", moved.reservedQuantity, "| requests visible here:", (s.partsRequests || []).length);
    result(moved.programUuid === "p2" && moved.reservedQuantity === 3 && /Reserved 3/.test(progress) && !!releaseError,
      `location transfer moved FILTER-1 to "Second program" with 3 still reserved for PR-00001 of the source program; the source request cannot release it (${releaseError}) and the destination shows "Reserved 3" (adjust: "${adjustError}")`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });
