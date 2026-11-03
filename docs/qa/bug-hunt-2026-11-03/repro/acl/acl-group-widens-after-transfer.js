// acl: editing a permission group whose only aircraft was transferred to
// another Flight Program silently widens it to ALL aircraft of the program.
const { start, nav, patchSnapshots, finish, OUT } = require("./ui/lib");
const scopedAircraft = (page) =>
  page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open("angel-one-v1");
    r.onsuccess = () => {
      const req = r.result.transaction("snapshots").objectStore("snapshots").get("demo");
      req.onsuccess = () => resolve(req.result.aircraft.map((a) => a.registration));
    };
  }));
(async () => {
  const { browser, page } = await start();
  let bug = false, detail = "";
  try {
    // 1. Second Flight Program.
    await nav(page, "Flight Programs");
    await page.getByRole("button", { name: /Add Flight Program/ }).click();
    let dlg = page.getByRole("dialog");
    await dlg.getByLabel("Flight Program name", { exact: true }).fill("Second program");
    await dlg.getByRole("button", { name: "Save Flight Program" }).click();
    await dlg.waitFor({ state: "hidden" });
    // 2. Group restricted to N206MA only.
    await nav(page, "Administration");
    await page.getByRole("group", { name: "Administration sections" }).getByRole("button", { name: "Permission groups" }).click();
    await page.getByRole("button", { name: "Add group" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByLabel("Group name").fill("N206 crew");
    await dlg.getByRole("combobox").selectOption({ label: "Mission operations" });
    await dlg.getByRole("checkbox", { name: "N206MA" }).check();
    await dlg.getByRole("checkbox", { name: "Add flights" }).check();
    await dlg.getByRole("button", { name: "Save" }).click();
    await dlg.waitFor({ state: "hidden" });
    const row = page.locator("article", { hasText: "N206 crew" });
    const before = await row.locator(".adm-group-meta").innerText();
    // Jordan Lee holds only the restricted group.
    await page.getByRole("group", { name: "Administration sections" }).getByRole("button", { name: "Users" }).click();
    await page.locator(".adm-row", { hasText: "Jordan Lee" }).getByRole("button", { name: "Edit access" }).click();
    dlg = page.getByRole("dialog");
    const mission = dlg.getByRole("group", { name: "Mission operations" });
    await mission.getByRole("checkbox", { name: /^Pilots/ }).uncheck();
    await mission.getByRole("checkbox", { name: /^N206 crew/ }).check();
    await dlg.getByRole("button", { name: "Save user" }).click();
    await dlg.waitFor({ state: "hidden" });
    // 3. Transfer N206MA to the second program.
    await nav(page, "Flight Programs");
    await page.getByLabel("Record to transfer").selectOption({ label: "N206MA" });
    await page.getByLabel("Destination Flight Program").selectOption({ label: "Second program" });
    await page.getByLabel("Transfer reason").fill("Aircraft moved to the second program.");
    await page.getByRole("button", { name: "Transfer record" }).click();
    await page.getByText("Record transferred to its destination Flight Program.").waitFor();
    // 4. Rename the restricted group (no aircraft change requested).
    await nav(page, "Administration");
    await page.getByRole("group", { name: "Administration sections" }).getByRole("button", { name: "Permission groups" }).click();
    const afterTransfer = await row.locator(".adm-group-meta").innerText();
    await row.getByRole("button", { name: "Edit group" }).click();
    dlg = page.getByRole("dialog");
    const checked = await dlg.getByRole("checkbox", { checked: true }).allInnerTexts();
    await dlg.getByLabel("Group name").fill("N206 crew (renamed)");
    await dlg.getByRole("button", { name: "Save" }).click();
    // Since the #34 fix the form may refuse the save (aircraft access is an
    // explicit choice); then close it and read the group as it stands.
    const refused = await Promise.race([
      dlg.waitFor({ state: "hidden" }).then(() => ""),
      dlg.getByRole("alert").waitFor().then(() => dlg.getByRole("alert").innerText()),
    ]);
    if (refused) {
      console.log("Save refused:", refused.trim());
      await dlg.getByRole("button", { name: "Close dialog" }).click();
      await dlg.waitFor({ state: "hidden" });
    }
    const renamed = page.locator("article", { hasText: "N206 crew" });
    const after = await renamed.locator(".adm-group-meta").innerText();
    await page.screenshot({ path: OUT + "/acl-group-widens-after-transfer.png", fullPage: true });
    // What Jordan Lee (only in that group) can now see in Mission operations.
    await patchSnapshots(page, (s) => {
      s.user = { ...s.members.find((m) => m.id === "demo-pilot") };
    });
    const jordanSees = await scopedAircraft(page);
    console.log({ before, afterTransfer, after, jordanSees });
    if (/All program aircraft/.test(after) || jordanSees.length) {
      bug = true;
      detail = `renaming group "N206 crew" (restricted to N206MA, since transferred out) widened it to "${after.split(" · ").pop()}"; its member now sees ${jordanSees.join(", ")}`;
    }
  } finally {
    await browser.close();
  }
  finish(bug, detail);
})();
