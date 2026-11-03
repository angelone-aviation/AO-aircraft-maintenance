// After every received part has been issued, the request still says
// "Received / awaiting issue" (and is hidden from the "Partially issued" filter).
const { start, go, seed, loc, stock, result } = require("./lib");
const { openPO, issue, receive } = require("./polib");
const { requestFromStock, requestsToPO, openRequest, requestAction } = require("./reqlib");
(async () => {
  const { browser, page } = await start();
  try {
    await seed(page, [{ ...loc("L1", "Main hangar"), address: "1 Hangar Rd" }, stock("S1", "L1", "FILTER-1", { description: "Oil filter", quantity: 0, cost: 10 }),
      { kind: "vendor", uuid: "V1", programUuid: "demo-program", version: 1, name: "Acme Parts", website: "", accountNumber: "", paymentTerms: "", notes: "" }]);
    await requestFromStock(page, "FILTER-1", 4);
    await requestsToPO(page, ["PR-00001"], "Acme Parts");
    await go(page, "/purchase-orders");
    const detail = await openPO(page);
    await issue(page, detail);
    const err = await receive(page, detail, { "FILTER-1": 2 }, { invoice: "INV-1" });
    if (err) throw new Error(err);
    let rd = await openRequest(page, "PR-00001");
    await rd.getByText("Reserved 2 · Issued 0").waitFor();
    await requestAction(page, rd, "issue", "S1", 2);
    await rd.getByText("Reserved 0 · Issued 2").waitFor();
    const heading = await rd.getByRole("heading").first().innerText();
    const progress = await rd.locator(".request-line p").first().innerText();
    console.log("Request:", heading, "|", progress);
    await page.screenshot({ path: "bug-request-status-awaiting-issue.png" });
    await rd.getByRole("button", { name: "Close dialog" }).click();
    await page.getByLabel("Status").selectOption("Partially issued");
    const listed = await page.getByRole("button", { name: "PR-00001", exact: true }).count();
    console.log("Listed under 'Partially issued' filter:", listed > 0);
    result(/Received \/ awaiting issue/.test(heading) && /Reserved 0 · Issued 2/.test(progress),
      `request with 2 of 4 issued, 0 reserved and 2 still on order shows "${heading.split("·").pop().trim()}"; 'Partially issued' filter lists it: ${listed > 0}`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });
