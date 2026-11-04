/**
 * Responsibility: Pins Flight Program administrators: they add users, groups
 *   and aircraft only in their current program, change and remove members'
 *   access, and delete a group after naming who loses access.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const PROGRAM_GROUPS = [
  {
    id: "program-admin",
    programUuid: "demo-program",
    name: "Program administrators",
    programAdmin: true,
    aircraftIds: [],
    permissions: ["read"],
  },
  {
    id: "program-maintenance",
    programUuid: "demo-program",
    name: "Program maintenance",
    programAdmin: false,
    aircraftIds: [],
    permissions: ["read", "maintenance"],
  },
  {
    id: "foreign-group",
    programUuid: "foreign",
    name: "Foreign administrators",
    programAdmin: true,
    aircraftIds: [],
    permissions: ["read"],
  },
];

test("program administrators add users only to their current program", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await becomeProgramAdmin(page);
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Permission groups", exact: true }),
  ).toHaveCount(0);
  // Only global administrators reset other users' passwords.
  await expect(
    page.getByRole("button", { name: "Reset password", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).not.toContainText("Foreign program");
  await expect(dialog).not.toContainText("Foreign administrators");
  await expect(
    dialog.getByRole("checkbox", { name: "Administrator", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Full name", { exact: true })
    .fill("Program New User");
  await dialog
    .getByLabel("Email", { exact: true })
    .fill("program-new@example.test");
  await dialog
    .getByLabel("Initial password", { exact: true })
    .fill("test-password-12345");
  await dialog
    .getByRole("checkbox", { name: "Program maintenance", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  const row = page
    .locator(".list-row")
    .filter({ hasText: "program-new@example.test" });
  await expect(row).toContainText("Program New User");
  await expect(row).toContainText("Program maintenance");
  await expect(row).not.toContainText("Foreign administrators");
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await dialog.getByLabel("Group name", { exact: true }).fill("Program pilots");
  await expect(
    dialog.getByLabel("Flight Program", { exact: true }),
  ).toHaveValue("demo-program");
  await expect(
    dialog.getByLabel("Flight Program", { exact: true }),
  ).not.toContainText("Foreign program");
  await dialog
    .getByRole("checkbox", { name: "Add flights", exact: true })
    .check();
  // Every program aircraft is an explicit choice, never an empty checklist.
  await dialog
    .getByRole("radio", { name: "All aircraft in this program", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await row
    .getByRole("button", { name: "Edit program access", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: "Program pilots", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save program access", exact: true })
    .click();
  await expect(row).toContainText("Program pilots");
  await row
    .getByRole("button", { name: "Edit program access", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", {
      name: "Remove access to this Flight Program",
      exact: true,
    })
    .check();
  await dialog
    .getByRole("button", { name: "Save program access", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  // The account still exists, so it can be added back by email.
  await page
    .getByRole("button", { name: "Add existing user", exact: true })
    .click();
  await dialog
    .getByLabel("Existing account email", { exact: true })
    .fill("program-new@example.test");
  await dialog
    .getByRole("checkbox", { name: "Program pilots", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save program access", exact: true })
    .click();
  await expect(row).toContainText("Program pilots");
  await page.getByRole("button", { name: "Add aircraft", exact: true }).click();
  await dialog.getByLabel("Registration", { exact: true }).fill("N123PA");
  await dialog.getByLabel("Make", { exact: true }).fill("Cessna");
  await dialog.getByLabel("Model", { exact: true }).fill("172");
  await dialog.getByLabel("Serial number", { exact: true }).fill("PA-123");
  await dialog
    .getByRole("button", { name: "Add aircraft", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(
    page.locator(".list-row").filter({ hasText: "N123PA" }),
  ).toBeVisible();
  const pilotGroup = page
    .locator(".list-row")
    .filter({ hasText: "Program pilots" })
    .filter({
      has: page.getByRole("button", { name: "Edit group", exact: true }),
    });
  await pilotGroup
    .getByRole("button", { name: "Delete group", exact: true })
    .click();
  // Program pilots is the new user's only group in this program.
  await expect(dialog).toContainText("Program New User");
  await expect(dialog).toContainText("loses access to this Flight Program");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(pilotGroup).toHaveCount(1);
  await pilotGroup
    .getByRole("button", { name: "Delete group", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete permission group", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(pilotGroup).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(pilotGroup).toHaveCount(0);
});

/**
 * Makes the signed-in demo user a non-administrator whose only group is the
 * demo program's administrators, and adds a foreign program and its group,
 * in every stored snapshot.
 */
async function becomeProgramAdmin(page: Page) {
  await page.evaluate(async (groups) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("snapshots", "readwrite");
    const cursor = tx.objectStore("snapshots").openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const s = entry.value;
      s.groups.push(...groups);
      s.programs.push({
        ...s.programs[0],
        uuid: "foreign",
        name: "Foreign program",
      });
      s.user = {
        ...s.user,
        isAdmin: false,
        groupIds: ["program-admin"],
        activeProgramUuid: "demo-program",
      };
      s.members = s.members.map((m: { id: string }) =>
        m.id === s.user.id ? s.user : m,
      );
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, PROGRAM_GROUPS);
}
