/**
 * Responsibility: Pins the Discrepancies list with realistic reports: the
 *   summary figures, one primary action per open report, each report's
 *   standing in words, resolutions under All, and on a phone a list that
 *   never scrolls sideways, 44px tap targets and tools under More actions.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 360, height: 780 };
// Apple's smallest tap target; the shared buttons promise it on phones.
const MIN_TAP = 44;
const OPEN_REPORTS = 5;
const ALL_REPORTS = 7;
const LONG_NAME = "Maximiliana Alexandra Featherstonehaugh-Worthington";
const RESOLUTION = "Cleaned and lubricated the seat rails; check good.";

test("desktop list shows figures, the column header and each report's standing", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openSeeded(page);
  await expect(figure(page, "Open")).toHaveText(String(OPEN_REPORTS));
  await expect(figure(page, "Grounding")).toHaveText("1");
  await expect(figure(page, "Deferred")).toHaveText("1");
  await expect(figure(page, "Resolved this month")).toHaveText("1");
  const head = page.locator(".disc-head");
  await expect(head).toBeVisible();
  await expect(head).toHaveText(/Problem\s*Reported\s*Status/);

  const reports = page.getByRole("main").getByRole("article");
  await expect(reports).toHaveCount(OPEN_REPORTS);
  for (const open of await reports.all())
    await expect(open.locator(".button.primary")).toHaveCount(1);
  const grounding = report(page, "Nose gear shimmy");
  await expect(grounding.locator(".ds-pill").first()).toHaveText(
    "Grounds aircraft",
  );
  await expect(grounding).toContainText(LONG_NAME);
  await expect(
    grounding.getByRole("button", { name: "Parts / repair requests" }),
  ).toBeVisible();
  const deferred = report(page, "navigation light");
  await expect(deferred.locator(".disc-status")).toContainText(
    /Deferred\s*Expires \d{4}-\d{2}-\d{2}/,
  );
  await expect(deferred.getByRole("button", { name: /^Defer/ })).toHaveCount(0);
  await expect(page.getByText(RESOLUTION)).toHaveCount(0);
  expect(await scrollWidth(page)).toBeLessThanOrEqual(DESKTOP.width);
});

test("All adds resolved reports with their resolution and no primary action", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openSeeded(page);
  const reports = page.getByRole("main").getByRole("article");
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "All", exact: true })
    .click();
  await expect(reports).toHaveCount(ALL_REPORTS);
  const resolved = report(page, "Pilot seat rail");
  await expect(resolved.locator(".ds-pill").first()).toHaveText("Resolved");
  await expect(resolved.getByText(RESOLUTION)).toBeVisible();
  await expect(
    resolved.getByRole("button", { name: "Record resolution" }),
  ).toHaveCount(0);
  expect(await scrollWidth(page)).toBeLessThanOrEqual(DESKTOP.width);
});

test("phone list fits 360px, folds tools under More actions and keeps 44px targets", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openSeeded(page);
  await expect(page.locator(".disc-head")).toBeHidden();
  expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);

  const grounding = report(page, "Nose gear shimmy");
  const parts = grounding.getByRole("button", {
    name: "Parts / repair requests",
  });
  await expect(parts).toBeHidden();
  const more = grounding.locator("summary", { hasText: "More actions" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(parts).toBeVisible();
  for (const target of [
    grounding.getByRole("button", { name: "Record resolution" }),
    more,
    parts,
    grounding.getByRole("button", { name: /^Defer/ }),
    grounding.getByRole("button", { name: "Add to work order" }),
  ])
    expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(
      MIN_TAP,
    );
  expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
});

function report(page: Page, text: string) {
  return page.getByRole("main").getByRole("article").filter({ hasText: text });
}

function figure(page: Page, label: string) {
  return page
    .locator(".disc-stats .ds-stat-tile")
    .filter({ hasText: label })
    .locator(".ds-stat-value");
}

function scrollWidth(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

/**
 * Opens the demo, replaces its reports in every stored snapshot with seven
 * across the three aircraft (open, grounding, deferred with an expiry, long
 * text and names, two resolved), and opens the screen.
 */
async function openSeeded(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await page.evaluate(storeReports, seededReports(Date.now()));
  await page.goto("/discrepancies");
  await expect(page.getByRole("main").getByRole("article")).toHaveCount(
    OPEN_REPORTS,
  );
}

interface SeedRow {
  uuid: string;
  aircraftUuid: string;
  daysAgo: number;
  description: string;
  grounding?: boolean;
  byLongName?: boolean;
  /** Deferred two days ago under an MEL item expiring in this many days. */
  expiresInDays?: number;
  resolvedDaysAgo?: number;
  resolution?: string;
}

const DAY_MS = 86_400_000;
const ADMIN_ID = "demo-admin";
const LONG_NAME_ID = "long-name";
const SEED_ROWS: SeedRow[] = [
  {
    uuid: "d1",
    aircraftUuid: "demo-208",
    daysAgo: 0.2,
    description: "Left landing light is intermittent.",
  },
  {
    uuid: "d2",
    aircraftUuid: "demo-206",
    daysAgo: 1,
    description:
      "Nose gear shimmy on landing roll; the shimmy damper looks dry and the torque link has visible play at the upper bushing.",
    grounding: true,
    byLongName: true,
  },
  {
    uuid: "d3",
    aircraftUuid: "demo-182",
    daysAgo: 2,
    description: "Left wing navigation light inoperative.",
    grounding: true,
    expiresInDays: 8,
  },
  {
    uuid: "d4",
    aircraftUuid: "demo-206",
    daysAgo: 3,
    description: "Oil seeping at the filter adapter.",
  },
  {
    uuid: "d5",
    aircraftUuid: "demo-208",
    daysAgo: 6,
    description: "Autopilot disconnects in light turbulence.",
    byLongName: true,
  },
  {
    uuid: "d6",
    aircraftUuid: "demo-182",
    daysAgo: 9,
    description: "Pilot seat rail stiff when adjusting.",
    resolvedDaysAgo: 0,
    resolution: RESOLUTION,
  },
  {
    uuid: "d7",
    aircraftUuid: "demo-208",
    daysAgo: 60,
    description: "Fuel quantity indication erratic.",
    resolvedDaysAgo: 45,
    resolution: "Replaced the sender connector.",
  },
];

function seededReports(now: number) {
  return {
    longName: LONG_NAME,
    longNameId: LONG_NAME_ID,
    reports: SEED_ROWS.map((row) => seededReport(row, now)),
  };
}

function seededReport(row: SeedRow, now: number) {
  const ago = (days: number) => now - days * DAY_MS;
  const { daysAgo, byLongName, expiresInDays, resolvedDaysAgo, ...kept } = row;
  return {
    ...kept,
    status: resolvedDaysAgo === undefined ? "open" : "resolved",
    authorId: byLongName ? LONG_NAME_ID : ADMIN_ID,
    createdAt: ago(daysAgo),
    ...(resolvedDaysAgo !== undefined && {
      resolvedBy: ADMIN_ID,
      resolvedAt: ago(resolvedDaysAgo),
    }),
    ...(expiresInDays !== undefined && {
      deferral: melDeferral(ago(2), ago(-expiresInDays)),
    }),
  };
}

function melDeferral(deferredAt: number, expiresAt: number) {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    type: "mel",
    melItem: "33-40-01",
    category: "C",
    placard: "INOP",
    deferredOn: day(deferredAt),
    deferredAt,
    deferredBy: ADMIN_ID,
    deferredByName: "Alex Morgan",
    expiresOn: day(expiresAt),
  };
}

// Runs in the page, so it may use only its argument.
async function storeReports(seed: {
  longName: string;
  longNameId: string;
  reports: object[];
}) {
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
    s.members.push({ ...s.user, id: seed.longNameId, name: seed.longName });
    s.discrepancies = seed.reports;
    entry.update(s);
    entry.continue();
  };
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
