/**
 * Responsibility: Pins that an aircraft whose setup has gaps reads "Setup
 *   incomplete" with the gaps named, never Airworthy, on the Overview card
 *   and detail, the Aircraft page and the board view, at phone and desktop
 *   sizes, and that a fully set-up aircraft still reads Airworthy.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain (airworthiness, components).
 */
import { test, expect, type Page } from "@playwright/test";
import { blankAD } from "../../src/domain/airworthiness";
import { componentSchema } from "../../src/domain/components";

const N208 = "demo-208";
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const SHOTS = process.env.UX_SHOTS;

test.use({ deviceScaleFactor: 2 });

for (const viewport of VIEWPORTS) {
  test(`an aircraft still being set up reads Setup incomplete (${viewport.name})`, async ({
    page,
  }) => {
    await openDemo(page, viewport);
    // N208MA has inspections but no components and no reviewed AD.
    const card = page.getByRole("article", { name: "N208MA", exact: true });
    await expect(card).toContainText("Setup incomplete");
    await expect(card).not.toContainText("Airworthy");
    await expect(card).toContainText("Components missing");
    await shoot(page, `setup-incomplete-overview-${viewport.name}`);

    await card
      .getByRole("button", { name: "View aircraft", exact: true })
      .click();
    const notes = page.getByRole("list", { name: "N208MA status notes" });
    await expect(notes).toContainText("Components missing");
    await expect(notes).toContainText("ADs not reviewed");
    await expect(page.locator(".dash-detail-pill")).toHaveText(
      "Setup incomplete",
    );
    await shoot(page, `setup-incomplete-detail-${viewport.name}`);
    await page.getByRole("button", { name: "Close dialog" }).click();

    await page.goto("/aircraft");
    const chips = page.getByLabel("N208MA setup", { exact: true });
    await expect(chips).toContainText("Components missing");
    await expect(
      page.locator(".ds-pill", { hasText: "Setup incomplete" }).first(),
    ).toBeVisible();
    await shoot(page, `setup-incomplete-aircraft-${viewport.name}`);

    await page.goto("/board");
    await expect(
      page.locator(".ds-kpi-label", { hasText: "Setup incomplete" }),
    ).toBeVisible();
    await shoot(page, `setup-incomplete-board-${viewport.name}`);
  });
}

test("a fully set-up aircraft still reads Airworthy", async ({ page }) => {
  await openDemo(page, VIEWPORTS[1]);
  await completeSetup(page, N208);
  await page.reload();
  const card = page.getByRole("article", { name: "N208MA", exact: true });
  await expect(card).toContainText("Airworthy");
  await expect(card).not.toContainText("Setup incomplete");
});

async function openDemo(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("article", { name: "N208MA", exact: true }),
  ).toBeVisible();
}

// Screenshots for review, in both themes, only when UX_SHOTS names a folder.
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const dark of [false, true]) {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      dark,
    );
    const theme = dark ? "dark" : "light";
    await page.screenshot({ path: `${SHOTS}/behaviour-${name}-${theme}.png` });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

// Gives the aircraft an installed component without limits and an AD that
// does not apply, in every stored copy of the demo snapshot.
async function completeSetup(page: Page, aircraftUuid: string) {
  const component = componentSchema.parse({
    uuid: "e2e-engine",
    kind: "component",
    version: 1,
    programUuid: "demo-program",
    aircraftUuid,
    componentType: "Engine",
    partNumber: "PN",
    serial: "SN-E2E",
    manufacturer: "",
    notes: "",
    trackTime: false,
    trackCycles: false,
    trackCalendar: false,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
  });
  const ad = { ...blankAD(aircraftUuid), applicability: "Not applicable" };
  await page.evaluate(
    async ({ component, ad }) => {
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
        entry.update({
          ...s,
          management: [...(s.management ?? []), component],
          airworthiness: [...(s.airworthiness ?? []), ad],
        });
        entry.continue();
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { component, ad },
  );
}
