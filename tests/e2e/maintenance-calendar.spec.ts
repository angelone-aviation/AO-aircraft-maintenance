/**
 * Responsibility: Pins the maintenance calendar on the demo fleet: the month
 *   grid on desktops and the agenda on phones, overdue items on today, month
 *   navigation, the aircraft filter, the undated list and item links.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * The demo's annuals fall due 24 days (N182MA) and 84 days (N206MA) from
 * today; its two 100-hour inspections have no flights to project from. The
 * spec adds a calendar inspection last done two years ago, so it is overdue.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const DAY_MS = 86_400_000;

test("lays the month out as a grid with overdue items on today (desktop)", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openDemo(page);
  await addOverdueAnnual(page);
  await page.getByRole("link", { name: "Maintenance calendar" }).click();
  await expect(
    page.getByRole("heading", { name: "Maintenance calendar", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(
    monthLabel(new Date()),
  );

  const today = page.locator('td[aria-current="date"]');
  const overdue = today.getByRole("link", { name: /N206MA · OLD-ANNUAL/ });
  await expect(overdue).toContainText("Overdue");

  const undated = page.getByRole("complementary", {
    name: "Due by hours, no date",
  });
  await expect(undated.getByRole("link")).toHaveCount(2);
  await expect(undated).toContainText("N208MA · 100-hour inspection");

  const annual = inDays(84);
  await showMonth(page, annual);
  await expect(
    page.getByRole("list", { name: dayLabel(annual) }).getByRole("link"),
  ).toHaveText("N206MA · Annual inspection");

  await page.getByLabel("Aircraft", { exact: true }).selectOption({
    label: "N182MA",
  });
  await expect(page.getByRole("list", { name: dayLabel(annual) })).toHaveCount(
    0,
  );
  await expect(undated.getByRole("link")).toHaveCount(0);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Aircraft", { exact: true }).selectOption("");
  await overdue.click();
  await expect(page).toHaveURL(/\/inspections$/);
});

test("becomes an agenda by day on phones", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openDemo(page);
  await page.goto("/planning/calendar");
  await expect(page.getByRole("table")).toHaveCount(0);
  const soon = inDays(24);
  await showMonth(page, soon);
  const agenda = page.getByRole("list", { name: /^Due in / });
  await expect(
    agenda.getByRole("heading", { name: dayLabel(soon) }),
  ).toBeVisible();
  await expect(
    agenda.getByRole("list", { name: dayLabel(soon) }).getByRole("link"),
  ).toHaveText("N182MA · Annual inspection");
  await page.getByRole("button", { name: "Next month" }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(
    page.getByRole("heading", { name: /^Nothing falls due in / }),
  ).toBeVisible();
});

async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

async function addOverdueAnnual(page: Page) {
  await page.goto("/inspections");
  await page
    .getByRole("button", { name: "New inspection", exact: true })
    .click();
  const form = page.getByRole("dialog", { name: "New inspection" });
  await form.getByLabel("Reference", { exact: true }).fill("OLD-ANNUAL");
  await form.getByLabel("Description", { exact: true }).fill("Calendar check");
  await form.getByRole("checkbox", { name: "Calendar", exact: true }).check();
  await form.getByLabel("Repeat every (months)", { exact: true }).fill("12");
  await form.getByLabel("Last compliance date").fill(inDays(-730));
  await form
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(form).not.toBeVisible();
}

// Steps forward from this month until the date's month shows.
async function showMonth(page: Page, iso: string) {
  const target = monthLabel(new Date(iso + "T00:00:00Z"));
  const heading = page.locator(".mcal-month");
  for (let step = 0; step < 4; step++) {
    if ((await heading.textContent()) === target) return;
    await page.getByRole("button", { name: "Next month" }).click();
  }
  await expect(heading).toHaveText(target);
}

// The demo seeds its dates the same way: today plus whole days, in UTC.
function inDays(days: number) {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

function monthLabel(date: Date) {
  return date.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(iso: string) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}
