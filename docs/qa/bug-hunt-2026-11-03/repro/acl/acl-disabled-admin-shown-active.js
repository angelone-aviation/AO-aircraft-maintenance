// acl: in Administration → Users a disabled system administrator is labelled
// "Administrator" (same as an active one) instead of "Disabled".
const { start, nav, finish, OUT } = require("./ui/lib");
(async () => {
  const { browser, page } = await start();
  let bug = false, detail = "";
  try {
    await nav(page, "Administration");
    await page.getByRole("button", { name: "Add user" }).click();
    let dlg = page.getByRole("dialog");
    await dlg.getByLabel("Full name").fill("Casey Former");
    await dlg.getByLabel("Email").fill("casey@example.test");
    await dlg.getByLabel("Initial password").fill("a-long-password-123");
    await dlg.getByRole("checkbox", { name: "Global administrator (all aircraft and settings)" }).check();
    await dlg.getByRole("button", { name: "Create account" }).click();
    await dlg.waitFor({ state: "hidden" });
    // Disable the account (as when an administrator leaves).
    const row = page.locator(".adm-row", { hasText: "Casey Former" });
    await row.getByRole("button", { name: "Edit access" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByRole("checkbox", { name: "Account active" }).uncheck();
    await dlg.getByRole("button", { name: "Save user" }).click();
    await dlg.waitFor({ state: "hidden" });
    const stored = await page.evaluate(() => new Promise((resolve) => {
      const r = indexedDB.open("angel-one-v1");
      r.onsuccess = () => {
        const req = r.result.transaction("snapshots").objectStore("snapshots").get("demo:all");
        req.onsuccess = () => resolve(req.result.members.find((m) => m.name === "Casey Former"));
      };
    }));
    const badge = (await row.locator(".adm-badge").innerText()).trim();
    await row.screenshot({ path: OUT + "/acl-disabled-admin-shown-active.png" });
    console.log({ active: stored.active, isAdmin: stored.isAdmin, badge });
    if (stored.active === false && badge !== "Disabled") {
      bug = true;
      detail = `disabled administrator account (active=false) is badged "${badge}" in the Users list`;
    }
  } finally {
    await browser.close();
  }
  finish(bug, detail);
})();
