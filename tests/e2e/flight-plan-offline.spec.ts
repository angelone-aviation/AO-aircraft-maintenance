/**
 * Responsibility: Pins resuming a plan's flight offline: a preflight saved
 *   online from a queued plan resumes from the queue with no connection, ends
 *   through the outbox and syncs once connected, while a plan with no saved
 *   preflight cannot be started offline and says why.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, tests/fixtures/localDateTime.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { localDateTime } from "../fixtures/localDateTime";

const HOUR_MS = 60 * 60 * 1000;
const FLY = { name: "Start / resume flight", exact: true };

test("a preflight saved from a plan resumes offline, ends and syncs", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flight-plans");
  await importPlanFor(page, 1);
  await importPlanFor(page, 2);
  await page.getByLabel("Aircraft", { exact: true }).selectOption("");
  const rows = page.getByRole("row").filter({ hasText: "MZBZ → KCHA" });
  const [flown, unstarted] = [rows.nth(0), rows.nth(1)];
  await flown.getByRole("button", FLY).click();
  await savePreflight(page);

  await context.setOffline(true);
  await page.reload();
  await expect(unstarted.getByRole("button", FLY)).toBeDisabled();
  await expect(unstarted.getByRole("button", FLY)).toHaveAccessibleDescription(
    "Starting needs a connection: this device's copy of the plan may be out of date.",
  );
  await flown.getByRole("button", FLY).click();
  await endFlight(page);
  await expect(
    page.getByText("1 entry waiting to send · Offline"),
  ).toBeVisible();
  await expect(flown).toContainText("Flight pending sync");

  await context.setOffline(false);
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  const logged = page.getByRole("row").filter({ hasText: "MZBZ" });
  await expect(logged).toContainText("KCHA");
  await expect(logged).toContainText("accepted");
});

/** Imports the ICAO fixture as a plan for the aircraft at that option index. */
async function importPlanFor(page: Page, index: number) {
  await page
    .getByLabel("Upload Flight Plan PDF")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Aircraft", { exact: true }).selectOption({ index });
  await dialog
    .getByLabel("Aircraft differs from the PDF: confirm reassignment")
    .check();
  await dialog
    .getByRole("button", { name: "Save flight plan", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

/** Verifies the aircraft and saves the plan's preflight on this device. */
async function savePreflight(page: Page) {
  const verify = page.getByRole("dialog", {
    name: "Start flight · Verify aircraft",
  });
  await verify.getByLabel(/I reviewed the aircraft maintenance status/).check();
  await verify.getByLabel(/I verified these starting readings/).check();
  await verify
    .getByRole("button", { name: "Verified — continue to flight information" })
    .click();
  const preflight = page.getByRole("dialog", {
    name: "Start flight · Flight information and preflight",
  });
  await preflight
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - HOUR_MS));
  await preflight.getByLabel("Fuel starting level (US gal)").fill("80");
  await preflight.getByLabel("Fuel quantity added (US gal)").fill("0");
  await preflight.getByLabel("Engine oil starting level (US qt)").fill("8");
  await preflight.getByLabel("Engine oil quantity added (US qt)").fill("0");
  await preflight
    .getByRole("button", { name: "Save preflight & start flight" })
    .click();
  await expect(preflight).not.toBeVisible();
}

/** Enters an ending Hobbs an hour past the opening and ends the flight. */
async function endFlight(page: Page) {
  const ending = page.getByRole("dialog", { name: "End flight", exact: true });
  await expect(ending.getByLabel("Origin", { exact: true })).toHaveValue(
    "MZBZ",
  );
  const start = Number(
    await ending.getByLabel("Starting Hobbs (hours)").inputValue(),
  );
  await ending
    .getByLabel("Ending Hobbs", { exact: false })
    .fill((start + 1).toFixed(1));
  await ending.getByRole("button", { name: "End flight & save" }).click();
  await expect(ending).not.toBeVisible();
}
