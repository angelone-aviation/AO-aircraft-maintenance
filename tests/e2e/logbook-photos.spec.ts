/**
 * Responsibility: Pins logbook page photos on flights: the offer after a
 *   flight saves, a photo kept on the device while the flight waits offline
 *   and uploaded once it syncs, the thumbnail on the flight row, the
 *   full-size view and archiving with a reason.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, tests/fixtures/localDateTime.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { localDateTime } from "../fixtures/localDateTime";

const HOUR_MS = 60 * 60 * 1000;
const PHOTO = path.resolve("public/icon-192.png");
const THUMBNAIL = { name: "Open logbook photo icon-192.png", exact: true };

test("offers a photo after a flight saves, shows it on the row and archives it with a reason", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flights");
  await logFlight(page, "PHOTO-ONLINE");
  const prompt = page.getByRole("status").filter({ hasText: "Flight saved." });
  await expect(prompt).toBeVisible();
  await prompt.locator("input[type=file]").setInputFiles(PHOTO);
  await expect(prompt.getByRole("button", THUMBNAIL)).toBeVisible();
  await prompt.getByRole("button", { name: "Done", exact: true }).click();
  await expect(prompt).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "PHOTO-ONLINE" });
  await expect(row.getByRole("button", THUMBNAIL)).toBeVisible();
  await page.reload();
  await row.getByRole("button", THUMBNAIL).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Logbook page — N206MA");
  await expect(dialog.getByRole("img", { name: "icon-192.png" })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Archive photo", exact: true })
    .click();
  await dialog.getByLabel("Reason for archiving icon-192.png").fill("Blurry");
  await dialog
    .getByRole("button", { name: "Archive copy", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row.getByRole("button", THUMBNAIL)).toHaveCount(0);
  await expect(row.getByText("Add a photo of the logbook line")).toBeVisible();
  await page.getByRole("link", { name: "Change history", exact: true }).click();
  await expect(
    page.getByText("Aircraft · file archived").first(),
  ).toBeVisible();
});

test("keeps a photo on the device while the flight waits offline and uploads it once the flight syncs", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flights");
  // Offline once the screen has loaded, so only the save itself is offline.
  await logFlight(page, "PHOTO-OFFLINE", () => context.setOffline(true));
  const prompt = page.getByRole("status").filter({ hasText: "Flight saved." });
  await prompt.locator("input[type=file]").setInputFiles(PHOTO);
  await expect(
    prompt.getByRole("img", { name: "icon-192.png, waiting to upload" }),
  ).toBeVisible();
  await expect(prompt.getByRole("button", THUMBNAIL)).toHaveCount(0);
  await page.getByRole("link", { name: /awaiting sync/ }).click();
  await expect(page.getByText("Photo waiting", { exact: true })).toBeVisible();
  await expect(page.getByText("2 pending entries")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Everything is synchronized")).toBeVisible();
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "PHOTO-OFFLINE" });
  await expect(row.getByRole("button", THUMBNAIL)).toBeVisible();
});

/**
 * Logs a one-hour flight on the first aircraft from the given origin;
 * `beforeSave` runs once the form is filled.
 */
async function logFlight(
  page: Page,
  origin: string,
  beforeSave: () => Promise<void> = async () => undefined,
) {
  await page
    .getByRole("button", { name: "Log a completed flight", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await selectAircraft(dialog, "N206MA");
  await dialog
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - HOUR_MS));
  const starting = Number(
    await dialog.getByLabel("Starting Hobbs (hours)").inputValue(),
  );
  await dialog
    .getByLabel("Ending Hobbs", { exact: false })
    .fill((starting + 1).toFixed(1));
  await dialog.getByLabel("Origin", { exact: true }).fill(origin);
  await beforeSave();
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}

async function selectAircraft(dialog: Locator, registration: string) {
  const select = dialog.getByLabel("Aircraft", { exact: true });
  const option = select.locator("option").filter({ hasText: registration });
  await select.selectOption(await option.getAttribute("value"));
}
