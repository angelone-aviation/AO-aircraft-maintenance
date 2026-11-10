/**
 * Responsibility: Pins the Overview's order per role: an administrator reads
 *   the fleet summary first, a mechanic what is overdue and due soon, and a
 *   pilot their aircraft and Log a flight, then AD alerts.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

type Permission = "read" | "flight" | "discrepancy" | "maintenance";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`on a ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      await openDemo(page);
    });

    test("an administrator sees the fleet summary first", async ({ page }) => {
      const s = sections(page);
      await expectInOrder([s.kpis, s.fleet, s.adAlerts, s.outlook, s.records]);
    });

    test("a mechanic sees the maintenance outlook first, then the fleet", async ({
      page,
    }) => {
      await becomeMember(page, ["read", "flight", "maintenance"]);
      const s = sections(page);
      await expectInOrder([s.outlook, s.adAlerts, s.kpis, s.fleet, s.records]);
    });

    test("a pilot sees their aircraft first, then AD alerts", async ({
      page,
    }) => {
      await becomeMember(page, ["read", "flight", "discrepancy"]);
      const s = sections(page);
      await expectInOrder([s.fleet, s.adAlerts, s.kpis, s.records]);
      await expect(s.outlook).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^Log flight/ }).first(),
      ).toBeVisible();
    });
  });
}

/** One landmark per Overview section, by what a reader sees. */
function sections(page: Page) {
  return {
    kpis: page.getByText("Aircraft in your fleet", { exact: true }),
    fleet: page.getByRole("heading", { name: /^Aircraft \d+$/ }),
    adAlerts: page.getByRole("heading", { name: "Airworthiness directives" }),
    outlook: page.getByRole("heading", { name: "Maintenance outlook" }),
    records: page.getByRole("heading", { name: /^Good records\./ }),
  };
}

// Document order is reading order: on wide screens the outlook and records
// callout share a row, and screen readers follow the document.
async function expectInOrder(landmarks: Locator[]) {
  for (const landmark of landmarks) await expect(landmark).toBeVisible();
  for (let i = 1; i < landmarks.length; i++) {
    const before = await landmarks[i - 1].elementHandle();
    const follows = await landmarks[i].evaluate(
      (after, earlier) =>
        !!earlier &&
        !!(
          earlier.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
      before,
    );
    expect(follows, `section ${i} follows section ${i - 1}`).toBe(true);
  }
}

async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

/**
 * Makes the demo user a non-administrator in one group of the demo program
 * with the given permissions, in every stored snapshot, and reopens the app.
 */
async function becomeMember(page: Page, permissions: Permission[]) {
  await page.evaluate(async (granted) => {
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
        id: "role-under-test",
        name: "Role under test",
        programUuid: "demo-program",
        aircraftIds: [],
        permissions: granted,
      });
      s.user = {
        ...s.user,
        isAdmin: false,
        groupIds: ["role-under-test"],
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
  }, permissions);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}
