/**
 * Responsibility: Pins the Administration layout for system and program
 *   administrators, on desktop and phone, and what moved to Settings.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

/** Opens Administration in the demo, signed in as its system administrator. */
async function openAdmin(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
}

test("administration tabs drive the primary action; backups and keys are in Settings", async ({
  page,
}) => {
  await openAdmin(page);
  await expect(page.getByText("Local demo.", { exact: true })).toBeVisible();
  const tabs = page.getByRole("group", { name: "Administration sections" });
  for (const [tab, action] of [
    ["Permission groups", "Add group"],
    ["Aircraft", "Add aircraft"],
    ["Users", "Add user"],
  ]) {
    await tabs.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      tabs.getByRole("button", { name: tab, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: action, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Add group", exact: true }),
  ).toHaveCount(0);
  const admin = page
    .locator(".list-row")
    .filter({ hasText: "alex@example.test" });
  await expect(admin).toContainText("Administrator");
  await expect(
    admin.getByRole("button", { name: "Edit access", exact: true }),
  ).toBeEnabled();
  // Demo accounts have no stored password to reset.
  await expect(
    admin.getByRole("button", { name: "Reset password", exact: true }),
  ).toBeDisabled();
  // Backups and integration keys moved to Settings → System.
  await expect(
    page.getByText(
      "FAA and address keys, the deployment's expiring dates and backups: Settings → System.",
    ),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Open System settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings#system$/);
  const download = page.waitForEvent("download");
  await page
    .getByRole("region", { name: "System", exact: true })
    .getByRole("button", { name: "Download aircraft.csv", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(
    /^angel-one-aircraft-.+\.csv$/,
  );
  for (const heading of [
    "CSV extract (partial)",
    "FAA API key and renewal",
    "Address verification",
  ])
    await expect(
      page
        .getByRole("region", { name: "System", exact: true })
        .getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
});

test("administration tabs fit a phone without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page);
  const box = await page
    .getByRole("group", { name: "Administration sections" })
    .getByRole("button", { name: "Aircraft", exact: true })
    .boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  // The segmented control's 40px minimum keeps each tab easy to tap.
  expect(box!.height).toBeGreaterThanOrEqual(40);
});

test("program administrators see sectioned users, groups and aircraft, with exports in Settings", async ({
  page,
}) => {
  await openAdmin(page);
  // Makes the demo user a program administrator, not a system administrator,
  // in every snapshot the demo cached; the reload below shows the result.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("angel-one-v1");
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("snapshots", "readwrite"),
            cursor = tx.objectStore("snapshots").openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            const s = entry.value;
            s.groups.push({
              id: "program-admin",
              programUuid: "demo-program",
              name: "Program administrators",
              programAdmin: true,
              aircraftIds: [],
              permissions: ["read"],
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
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Local demo.", { exact: true })).toBeVisible();
  for (const heading of ["Users", "Permission groups", "Aircraft"])
    await expect(
      page.getByRole("heading", { level: 2, name: heading, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Administration sections" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".list-row")
      .filter({ hasText: "Program administrators" })
      .getByRole("button", { name: "Edit group", exact: true }),
  ).toBeVisible();
  // Program details and exports moved to Settings → Flight Program.
  await expect(
    page.getByRole("heading", { name: "CSV extract (partial)", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Program details, labor rate, expiring dates, Aircraft Spruce account and exports: Settings → Flight Program.",
    ),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Flight Program settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings#program$/);
  await expect(
    page.getByRole("heading", {
      level: 3,
      name: "CSV extract (partial)",
      exact: true,
    }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download flights.csv", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("demo-program-flights.csv");
});
