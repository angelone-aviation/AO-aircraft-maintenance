import { test, expect } from "@playwright/test";
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
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("angel-one-v1");
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("snapshots", "readwrite"),
            cursor = tx.objectStore("snapshots").openCursor();
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
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
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
