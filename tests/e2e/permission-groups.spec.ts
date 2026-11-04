/**
 * Responsibility: Pins permission-group aircraft access (#34): every program
 *   aircraft only by explicit choice, a group whose aircraft left kept
 *   restricted, the notice for groups an earlier edit opened, and the
 *   Disabled badge on a disabled administrator (#53).
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const CHOOSE_AIRCRAFT =
  "Choose the aircraft this group can access, or choose all aircraft in this program.";
// Seed-script source for the N206 crew group's fields, before an id is set.
const CREW_SOURCE = `{ name: "N206 crew", programUuid: "demo-program",
    programAdmin: false, owner: false, permissions: ["read", "flight"] }`;

test("a group whose aircraft left the program stays restricted until aircraft or all aircraft are chosen (#34)", async ({
  page,
}) => {
  await openAdmin(page);
  await seed(
    page,
    `s.programs.push({ ...s.programs[0], uuid: "second", name: "Second program" });
     s.groups.push({ id: "n206-crew", name: "N206 crew", programUuid: "demo-program",
       aircraftIds: ["demo-206"], permissions: ["read", "flight"] });
     s.members = s.members.map((m) =>
       m.id === "demo-pilot" ? { ...m, groupIds: ["n206-crew"] } : m);`,
  );
  await transferN206ToSecondProgram(page);

  await page.goto("/admin");
  await groupsTab(page);
  const row = page.locator(".adm-group").filter({ hasText: "N206 crew" });
  await expect(row.locator(".adm-group-meta")).toContainText(
    "No aircraft in this program",
  );
  await row.getByRole("button", { name: "Edit group", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("radio", { name: "Only selected aircraft" }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "All aircraft in this program" }),
  ).not.toBeChecked();
  await expect(dialog.getByRole("status")).toContainText(
    "No aircraft in this program.",
  );
  for (const registration of ["N208MA", "N182MA"])
    await expect(
      dialog.getByRole("checkbox", { name: registration, exact: true }),
    ).not.toBeChecked();
  // Renaming alone must not open the group to every program aircraft.
  await dialog.getByLabel("Group name").fill("N206 crew (renamed)");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(CHOOSE_AIRCRAFT);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(row.locator(".adm-group-name")).toHaveText("N206 crew");
  await expect(row.locator(".adm-group-meta")).toContainText(
    "No aircraft in this program",
  );

  // Choosing an aircraft restricts the group to it.
  await row.getByRole("button", { name: "Edit group", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "N208MA", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.locator(".adm-group-meta")).toContainText("1 aircraft");

  // Every program aircraft only when chosen.
  await row.getByRole("button", { name: "Edit group", exact: true }).click();
  await dialog
    .getByRole("radio", { name: "All aircraft in this program" })
    .check();
  await expect(
    dialog.getByRole("checkbox", { name: "N208MA", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.locator(".adm-group-meta")).toContainText(
    "All program aircraft",
  );
});

test("a new permission group needs an explicit aircraft access choice (#34)", async ({
  page,
}) => {
  await openAdmin(page);
  await groupsTab(page);
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Group name").fill("Line pilots");
  await dialog.getByRole("checkbox", { name: "Add flights" }).check();
  for (const name of ["All aircraft in this program", "Only selected aircraft"])
    await expect(dialog.getByRole("radio", { name })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(CHOOSE_AIRCRAFT);
  await dialog.getByRole("radio", { name: "Only selected aircraft" }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog
    .getByRole("radio", { name: "All aircraft in this program" })
    .check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(groupMeta(page, "Line pilots")).toContainText(
    "All program aircraft",
  );
  // Checking an aircraft chooses selected aircraft.
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await dialog.getByLabel("Group name").fill("N182 crew");
  await dialog.getByRole("checkbox", { name: "N182MA", exact: true }).check();
  await expect(
    dialog.getByRole("radio", { name: "Only selected aircraft" }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(groupMeta(page, "N182 crew")).toContainText("1 aircraft");
  // Program administrators cover every aircraft; no choice is asked.
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await dialog.getByLabel("Group name").fill("Managers");
  await dialog
    .getByRole("checkbox", { name: "Flight Program administrator" })
    .check();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(
    dialog.getByText(
      "Flight Program administrators can access every aircraft in this program.",
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("a disabled administrator is badged Disabled (#53)", async ({ page }) => {
  await openAdmin(page);
  await seed(
    page,
    `s.members.push({ id: "former-admin", name: "Casey Former",
       email: "casey@example.test", isAdmin: true, active: false, groupIds: [] });`,
  );
  const row = page
    .locator(".adm-row")
    .filter({ hasText: "casey@example.test" });
  await expect(row.locator(".adm-badge")).toHaveText("Disabled");
  await expect(
    page
      .locator(".adm-row")
      .filter({ hasText: "alex@example.test" })
      .locator(".adm-badge"),
  ).toHaveText("Administrator");
});

test("Administration lists groups an edit before the #34 fix opened to all aircraft until an administrator chooses", async ({
  page,
}) => {
  await openAdmin(page);
  await seed(
    page,
    `const crew = ${CREW_SOURCE};
     s.programs.push({ ...s.programs[0], uuid: "second", name: "Second program" });
     s.groups.push({ ...crew, id: "n206-crew", aircraftIds: ["demo-206"] },
       { ...crew, id: "line-crew", name: "Line crew", aircraftIds: [] });
     s.members = s.members.map((m) =>
       m.id === "demo-pilot" ? { ...m, groupIds: ["n206-crew"] } : m);
     s.audit.unshift(
       ${groupSavedSource("2026-10-01T12:00:00Z", "undefined", '{ ...crew, id: "line-crew", name: "Line crew", aircraftIds: [] }')},
       ${groupSavedSource("2026-10-01T12:00:00Z", "undefined", '{ ...crew, id: "n206-crew", aircraftIds: ["demo-206"] }')});`,
  );
  await transferN206ToSecondProgram(page);
  // Before the fix, renaming the group then dropped N206MA and saved it empty.
  await seed(
    page,
    `const crew = ${CREW_SOURCE};
     s.groups = s.groups.map((g) =>
       g.id === "n206-crew" ? { ...g, aircraftIds: [] } : g);
     s.audit.unshift(${groupSavedSource(
       "2026-10-20T12:00:00Z",
       'JSON.stringify({ ...crew, aircraftIds: ["demo-206"] })',
       '{ ...crew, id: "n206-crew", aircraftIds: [] }',
     )});`,
  );

  await page.goto("/admin");
  await groupsTab(page);
  const notice = page.getByRole("region", {
    name: "Check aircraft access for 2 permission groups",
  });
  await expect(notice).toBeVisible();
  const items = notice.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("N206 crew");
  await expect(items.nth(0)).toContainText("Opened to all aircraft");
  await expect(items.nth(0)).toContainText(
    "Limited to N206MA (now in Second program) until Alex Morgan saved it with no aircraft on Oct 20, 2026.",
  );
  await expect(items.nth(0)).toContainText("Members: Jordan Lee");
  await expect(items.nth(1)).toContainText("Line crew");
  await expect(items.nth(1)).toContainText(
    "Cannot determine: Alex Morgan created it with all aircraft on Oct 1, 2026, before the form asked for an explicit choice.",
  );
  await expect(items.nth(1)).toContainText("No members");
  // Nothing was changed automatically.
  const row = page.locator(".adm-group").filter({ hasText: "N206 crew" });
  await expect(row.locator(".adm-group-meta")).toContainText(
    "All program aircraft",
  );

  // The form asks for the choice again; saving unchanged is refused.
  await items
    .nth(0)
    .getByRole("button", { name: "Edit group", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Confirm aircraft access.");
  for (const name of ["All aircraft in this program", "Only selected aircraft"])
    await expect(dialog.getByRole("radio", { name })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(CHOOSE_AIRCRAFT);
  await dialog
    .getByRole("radio", { name: "All aircraft in this program" })
    .check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const remaining = page.getByRole("region", {
    name: "Check aircraft access for 1 permission group",
  });
  await expect(remaining.getByRole("listitem")).toHaveCount(1);
  await expect(remaining).toContainText("Line crew");
  await expect(row.locator(".adm-group-meta")).toContainText(
    "All program aircraft",
  );

  // Restricting the other group clears the notice.
  await remaining
    .getByRole("button", { name: "Edit group", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: "N208MA", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(remaining).toHaveCount(0);
  await expect(groupMeta(page, "Line crew")).toContainText("1 aircraft");
});

/**
 * Runs `script` on every stored demo snapshot with a signed-in user, as the
 * body of a function of `s`, then reloads.
 */
async function seed(page: Page, script: string) {
  await page.evaluate(async (source) => {
    const edit = new Function("s", source) as (s: unknown) => void;
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
      if (entry.value?.user) {
        edit(entry.value);
        entry.update(entry.value);
      }
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, script);
  await page.reload();
}

/** Seed-script source for a change-log entry as saveGroup wrote it before #34. */
function groupSavedSource(at: string, before: string, after: string) {
  return `{ uuid: crypto.randomUUID(), at: Date.parse("${at}"), actorId: "demo-admin",
       action: "group.saved", entityUuid: ${after}.id, before: ${before},
       after: JSON.stringify({ ...${after}, id: undefined }) }`;
}

async function openAdmin(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
}

async function groupsTab(page: Page) {
  await page
    .getByRole("group", { name: "Administration sections" })
    .getByRole("button", { name: "Permission groups", exact: true })
    .click();
}

/** Moves N206MA to the seeded Second program, out of the N206 crew's reach. */
async function transferN206ToSecondProgram(page: Page) {
  await page.goto("/programs");
  const transfer = page.locator("section[aria-labelledby=ops-transfer-title]");
  await transfer
    .getByLabel("Record to transfer")
    .selectOption({ label: "N206MA" });
  await transfer
    .getByLabel("Destination Flight Program")
    .selectOption({ label: "Second program" });
  await transfer
    .getByLabel("Transfer reason")
    .fill("Aircraft moved to the second program.");
  await transfer.getByRole("button", { name: "Transfer record" }).click();
  await expect(
    page.getByText("Record transferred to its destination Flight Program."),
  ).toBeVisible();
}

function groupMeta(page: Page, name: string) {
  return page
    .locator(".adm-group")
    .filter({ hasText: name })
    .locator(".adm-group-meta");
}
