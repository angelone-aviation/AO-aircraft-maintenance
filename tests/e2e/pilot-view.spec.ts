/**
 * Responsibility: Pins the pilot view: a member with only read, flight and
 *   discrepancy permissions keeps flight and problem-report tools and sees no
 *   maintenance or administration screens.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

test("pilot view keeps flight and discrepancy tools while hiding maintenance management", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await becomePilot(page);
  await page.reload();
  for (const name of [
    "Flight log",
    "Discrepancies",
    "Checklists",
    "Flight plans",
    "Reference library",
    "Sync center",
  ])
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of [
    "Inspections",
    "Work orders",
    "Job cards",
    "Components",
    "Parts & repair requests",
    "Inventory",
    "Purchase orders",
    "Vendors",
    "Administration",
    "Flight Programs",
    "Change history",
  ])
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Maintenance outlook" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Aircraft status:", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Log a flight", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page
    .getByRole("button", { name: "Report a problem", exact: true })
    .click();
  await page
    .getByLabel("What did you observe?", { exact: true })
    .fill("Pilot view test: cabin light is out");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Save|Report/ })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByText("Pilot view test: cabin light is out", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Request parts", exact: true }),
  ).toHaveCount(0);
});

/**
 * Makes the signed-in demo user a non-administrator in one Pilots group with
 * read, flight and discrepancy permissions, in every stored snapshot.
 */
async function becomePilot(page: Page) {
  await page.evaluate(async () => {
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
      s.groups.push({
        id: "pilot-only",
        name: "Pilots",
        programUuid: "demo-program",
        aircraftIds: [],
        permissions: ["read", "flight", "discrepancy"],
      });
      s.user = {
        ...s.user,
        isAdmin: false,
        groupIds: ["pilot-only"],
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
    });
    db.close();
  });
}
