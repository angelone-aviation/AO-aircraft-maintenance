/**
 * Responsibility: Pins that the Dashboard, Alerts, flight plans, Inspections,
 *   status sheet and owner portal open with an aircraft whose meter has no
 *   reading, showing what can be read.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain/airworthiness.ts and
 *   flightPlans.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { blankAD, blankADTask, type AD } from "../../src/domain/airworthiness";
import {
  flightPlanSchema,
  type FlightPlan,
} from "../../src/domain/flightPlans";

const N206 = "demo-206";
const N208 = "demo-208";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("article", { name: "N208MA", exact: true }),
  ).toBeVisible();
});

test("the Dashboard and Alerts open with an aircraft whose meter has no reading", async ({
  page,
}) => {
  const card = page.getByRole("article", { name: "N208MA", exact: true });
  await storeWithoutReading(page, {
    uuids: [N208],
    ads: [unreadAD("AD-UNREAD"), unreadAD("AD-UNREAD-LATE", "2020-01-01")],
  });
  await page.reload();
  await expect(card).toContainText("Not recorded");
  await expect(card).toContainText("AD AD-UNREAD-LATE overdue");
  await expect(
    page.getByText("Counter unavailable", { exact: true }),
  ).toBeVisible();

  await page.goto("/alerts");
  await expect(
    page.getByRole("heading", { name: "What needs attention.", exact: true }),
  ).toBeVisible();
  const markRead = (title: string | RegExp) =>
    page.getByRole("button", {
      name: typeof title === "string" ? `Mark read: ${title}` : title,
      exact: true,
    });
  await expect(markRead("AD AD-UNREAD-LATE overdue")).toBeVisible();
  await expect(markRead("N208MA is grounded")).toBeVisible();
  await expect(markRead(/^Mark read: AD AD-UNREAD /)).toHaveCount(0);
});

test("flight plans, Inspections, the status sheet and the owner portal open with aircraft whose meter has no reading", async ({
  page,
}) => {
  // N208 has no inspections, which would refuse its status sheet.
  await storeWithoutReading(page, {
    uuids: [N206, N208],
    plans: [queuedPlan(N206)],
    bare: [N208],
  });
  await page.goto("/flight-plans");
  await expect(
    page.getByRole("region", { name: "N206MA flight plans", exact: true }),
  ).toContainText("Projected total Not recorded");

  await page.goto("/inspections");
  await expect(
    page.getByRole("row").filter({ hasText: "N206MA" }).first(),
  ).toContainText("Unknown");

  await page.goto("/");
  await page
    .getByRole("article", { name: "N208MA", exact: true })
    .getByRole("button", { name: "View aircraft", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export status sheet", exact: true })
    .click();
  expect((await downloading).suggestedFilename()).toMatch(/^N208MA-status-/);

  await page.goto("/");
  await page.getByRole("button", { name: "Preview owner portal" }).click();
  const owned = page.getByRole("region", { name: "N206MA", exact: true });
  await expect(owned).toContainText("Not recorded");
  await expect(owned).toContainText("Review");
});

/** A plan queued on the aircraft, so its flight plans project a total. */
function queuedPlan(aircraftUuid: string): FlightPlan {
  return flightPlanSchema.parse({
    uuid: crypto.randomUUID(),
    version: 1,
    aircraftUuid,
    registration: "N206MA",
    departureAt: "2026-12-01T08:00:00.000Z",
    origin: "KAAA",
    destination: "KBBB",
    alternate: "",
    durationMinutes: 60,
    cycles: 1,
    landings: 1,
    flightRules: "I",
    aircraftType: "C206",
    flightType: "G",
    speed: "",
    level: "",
    route: "",
    pilotText: "",
    equipment: "",
    otherInformation: "",
    sourceName: "plan.pdf",
    sourceHash: "a".repeat(64),
    status: "proposed",
    createdAt: 0,
  });
}

/** An applicable AD on N208MA with an hours limit, and a due date if given. */
function unreadAD(number: string, dueDate?: string): AD {
  const r = blankAD(N208);
  const action = (uuid: string, fields: object) => ({
    ...blankADTask(),
    uuid: `${number}-${uuid}`,
    description: "Inspect",
    ...fields,
  });
  return {
    ...r,
    uuid: number,
    applicability: "Applicable",
    reviewRequired: false,
    source: { ...r.source, number, subject: "Subject" },
    tasks: [
      action("hours", { dueHours: 5000, intervalHours: 100 }),
      ...(dueDate ? [action("date", { dueDate, intervalDays: 30 })] : []),
    ],
  };
}

/**
 * Makes each listed aircraft's flight time log its meter, without a reading,
 * removes the inspections of the `bare` ones, and adds the ADs and plans, in
 * every snapshot on the device, so the next load opens on them.
 */
async function storeWithoutReading(
  page: Page,
  change: {
    uuids: string[];
    ads?: AD[];
    plans?: FlightPlan[];
    bare?: string[];
  },
) {
  await page.evaluate(async ({ uuids, ads = [], plans = [], bare = [] }) => {
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
        aircraft: s.aircraft.map((a: { uuid: string }) =>
          uuids.includes(a.uuid)
            ? {
                ...a,
                meter: "flightTimeLog",
                flightTimeLog: true,
                currentFlightTimeLog: undefined,
              }
            : a,
        ),
        airworthiness: [...(s.airworthiness ?? []), ...ads],
        flightPlans: [...(s.flightPlans ?? []), ...plans],
        inspections: s.inspections.filter(
          (i: { aircraftUuid: string }) => !bare.includes(i.aircraftUuid),
        ),
      });
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, change);
}
