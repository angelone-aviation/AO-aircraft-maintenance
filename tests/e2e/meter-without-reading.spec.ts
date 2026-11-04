/**
 * Responsibility: Pins that the Dashboard and Alerts open with an aircraft
 *   whose meter has no reading, judging its ADs on what can be read.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain/airworthiness.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { blankAD, blankADTask, type AD } from "../../src/domain/airworthiness";

const N208 = "demo-208";

test("the Dashboard and Alerts open with an aircraft whose meter has no reading", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  const card = page.getByRole("article", { name: "N208MA", exact: true });
  await expect(card).toBeVisible();
  await storeWithoutReading(page, [
    unreadAD("AD-UNREAD"),
    unreadAD("AD-UNREAD-LATE", "2020-01-01"),
  ]);
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
 * Makes N208MA's flight time log its meter, without a reading, and adds the
 * ADs, in every snapshot on the device, so a reload opens on them.
 */
async function storeWithoutReading(page: Page, ads: AD[]) {
  await page.evaluate(
    async ({ uuid, ads }) => {
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
        const a = s.aircraft.find((x: { uuid: string }) => x.uuid === uuid);
        Object.assign(a, { meter: "flightTimeLog", flightTimeLog: true });
        delete a.currentFlightTimeLog;
        entry.update({
          ...s,
          airworthiness: [...(s.airworthiness ?? []), ...ads],
        });
        entry.continue();
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { uuid: N208, ads },
  );
}
