// acl: docs/flight-program-access.md step 5 tells system administrators to
// "Assign existing unscoped permission groups to a program". Saving such a
// group with a Flight Program is refused ("cannot be moved").
const { start, nav, patchSnapshots, finish, OUT } = require("./ui/lib");
(async () => {
  const { browser, page } = await start();
  let bug = false, detail = "";
  try {
    // A legacy permission group created before Flight Programs (no programUuid),
    // held by the demo pilot.
    await patchSnapshots(page, (s) => {
      if (!s.groups.some((g) => g.id === "legacy-maint"))
        s.groups.push({
          id: "legacy-maint",
          name: "Legacy maintenance",
          programAdmin: false,
          aircraftIds: [],
          permissions: ["read", "maintenance"],
        });
      s.members = s.members.map((m) =>
        m.id === "demo-pilot" ? { ...m, groupIds: [...m.groupIds, "legacy-maint"] } : m,
      );
    });
    await page.getByRole("combobox", { name: "Active Flight Program" }).first().selectOption({ label: "Unassigned records" });
    await nav(page, "Administration");
    await page.getByRole("group", { name: "Administration sections" }).getByRole("button", { name: "Permission groups" }).click();
    const row = page.locator("article", { hasText: "Legacy maintenance" });
    await row.getByRole("button", { name: "Edit group" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("combobox").selectOption({ label: "Mission operations" });
    await dlg.getByRole("button", { name: "Save" }).click();
    const error = dlg.getByRole("alert");
    const outcome = await Promise.race([
      dlg.waitFor({ state: "hidden" }).then(() => "saved"),
      error.waitFor().then(() => "error"),
    ]);
    if (outcome === "error") { await dlg.locator(".modal-body, form").first().evaluate((e) => e.scrollTo(0, 1e6)).catch(() => {}); await error.evaluate((e) => e.scrollIntoView({ block: "center" })); }
    await page.screenshot({ path: OUT + "/acl-unscoped-group-cannot-be-assigned.png" });
    if (outcome === "error") {
      bug = true;
      detail = `assigning the unscoped group to "Mission operations" failed: ${(await error.innerText()).trim()}`;
    }
  } finally {
    await browser.close();
  }
  finish(bug, detail);
})();
