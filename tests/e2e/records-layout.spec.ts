/**
 * Responsibility: Pins the record lists' layout: flight-log status filters,
 *   pending flights linked to the Sync center, cards on phones, and the
 *   discrepancy counts, resolved switch and change-history aircraft filter.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };

test("flight log filters by status, links pending entries to Sync center and stacks cards on phones", async ({
  page,
  context,
}) => {
  await demo(page);
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(page.getByText("No flights in this view")).toBeVisible();
  // One hour on from N206MA's 2,341.2 Hobbs.
  await logFlight(page, "2342.2", "2026-01-01T10:00");
  const filters = page.getByRole("group", { name: "Flight status" });
  await expect(
    filters.getByRole("button", { name: "All flights", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("KSEA");
  await filters
    .getByRole("button", { name: "Needs review", exact: true })
    .click();
  await expect(
    filters.getByRole("button", { name: "Needs review", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("No flights in this view")).toBeVisible();
  await filters.getByRole("button", { name: "Accepted", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "accepted", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Correct", exact: true }),
  ).toBeVisible();

  // Offline, the flight waits in the outbox and syncs on reconnect.
  await context.setOffline(true);
  await logFlight(page, "2343.2", "2026-01-02T10:00");
  const chip = page.getByRole("link", {
    name: /1 flight entry awaiting sync/,
  });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(
    page.getByRole("heading", { name: "1 pending entry", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Awaiting sync", { exact: true })).toHaveCount(1);
  await context.setOffline(false);
  await expect(
    page.getByRole("heading", { name: "0 pending entries", exact: true }),
  ).toBeVisible();

  await page.setViewportSize(PHONE);
  await page.goto("/flights");
  await expect(page.locator("table")).toHaveCount(0);
  await expect(
    page.locator("article").filter({ hasText: "N206MA" }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Correct", exact: true }),
  ).toHaveCount(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);
});

test("discrepancy counts, resolved switch and history filter follow recorded data", async ({
  page,
}) => {
  await demo(page);
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await expect(page.getByText("1 open", { exact: true })).toBeVisible();
  await expect(page.getByText("0 deferred", { exact: true })).toBeVisible();
  const resolved = page.getByRole("switch", {
    name: "Include resolved reports",
  });
  await expect(resolved).not.toBeChecked();
  await page.getByRole("button", { name: "Record resolution" }).click();
  await page
    .getByLabel("What fixed the problem?")
    .fill("Reseated the landing light connector.");
  await page.getByRole("button", { name: "Mark resolved" }).click();
  await expect(page.getByText("0 open", { exact: true })).toBeVisible();
  await expect(page.getByText("No open reports")).toBeVisible();
  await resolved.check();
  await expect(resolved).toBeChecked();
  await expect(
    page.getByText("Reseated the landing light connector.", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Change history", exact: true }).click();
  const reason = page.getByText("Reseated the landing light connector.", {
    exact: true,
  });
  await expect(reason).toBeVisible();
  // The demo's one open report is on N208MA.
  const aircraft = page.getByLabel("Aircraft", { exact: true });
  await aircraft.selectOption({ label: "N206MA" });
  await expect(reason).toHaveCount(0);
  await aircraft.selectOption({ label: "N208MA" });
  await expect(reason).toBeVisible();
});

/** Opens the demo with the service worker controlling the page. */
async function demo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  const home = page.getByRole("heading", { name: "Your fleet, at a glance." });
  await expect(home).toBeVisible();
  // The service worker controls only pages loaded after it activates.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(home).toBeVisible();
}

/** Logs a KSEA to KBFI flight on the default aircraft at a Hobbs reading. */
async function logFlight(page: Page, ending: string, time: string) {
  await page
    .getByRole("button", { name: "Log a completed flight", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Log a flight" });
  await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill(ending);
  await dialog.getByLabel("Flight date & time").fill(time);
  await dialog.getByLabel("Origin", { exact: true }).fill("KSEA");
  await dialog.getByLabel("Destination", { exact: true }).fill("KBFI");
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
