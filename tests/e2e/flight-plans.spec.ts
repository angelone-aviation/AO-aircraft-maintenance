/**
 * Responsibility: Pins flight plans: the ICAO PDF import and review, copies,
 *   search and grouping, and logging a flight from a plan through Start flight
 *   and End flight, which retires the plan.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, node:path, tests/fixtures/localDateTime.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { localDateTime } from "../fixtures/localDateTime";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;

test("imports the fixed ICAO PDF, projects, persists, logs and removes plans", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flight-plans");
  await expect(
    page.getByRole("heading", { name: "Flight plans", exact: true }),
  ).toBeVisible();
  await uploadIcaoPlan(page);
  const dialog = page.getByRole("dialog");
  await expect(
    page.getByRole("heading", { name: "Review imported flight plan" }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Departure airport", { exact: true }),
  ).toHaveValue("MZBZ");
  await expect(
    dialog.getByLabel("Estimated flight duration (minutes)"),
  ).toHaveValue("293");
  await expect(dialog.getByLabel("Planned route")).toHaveValue(
    "DCT BZE R899 CTM UJ26 MID UL209 KEHLI A770 LEV DCT",
  );
  await saveForAircraft(dialog, 1);
  await expect(page.getByText("4h 53m", { exact: true }).first()).toBeVisible();
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: "MZBZ → KCHA" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Copy plan", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Copy flight plan" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Flight date (UTC)")).toHaveValue("");
  await expect(dialog.getByLabel("Destination airport")).toHaveValue("KCHA");
  await dialog.getByLabel("Flight date (UTC)").fill("2026-11-01");
  await dialog.getByLabel("Destination airport").fill("KATL");
  await dialog.getByRole("button", { name: "Save copy", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  const copyRow = page.getByRole("row").filter({ hasText: "MZBZ → KATL" });
  await expect(copyRow).toBeVisible();
  await expect(row).toBeVisible();
  await page.getByLabel("Aircraft", { exact: true }).selectOption("");
  await expect(page.locator(".flight-plan-group-heading h2")).toHaveCount(1);
  await page.getByLabel("Search flight plans").fill("KATL");
  await expect(copyRow).toBeVisible();
  await expect(row).not.toBeVisible();
  await page.getByLabel("Search flight plans").fill("no-such-airport");
  await expect(
    page.getByText("No matching flight plans", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search flight plans").fill("");
  await expect(row).toBeVisible();

  await copyRow.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove from queue" }).click();
  await expect(copyRow).not.toBeVisible();
  await row.getByRole("button", { name: "Edit plan" }).click();
  await dialog.getByLabel("Estimated flight duration (minutes)").fill("300");
  await dialog
    .getByRole("button", { name: "Save flight plan", exact: true })
    .click();
  await expect(row).toContainText("5h 00m");
  // Logging from a plan takes Start flight (verify, preflight), then End
  // flight.
  await row
    .getByRole("button", { name: "Start / resume flight", exact: true })
    .click();
  const verify = page.getByRole("dialog", {
    name: "Start flight · Verify aircraft",
    exact: true,
  });
  await verify.getByLabel(/I reviewed the aircraft maintenance status/).check();
  await verify.getByLabel(/I verified these starting readings/).check();
  await verify
    .getByRole("button", {
      name: "Verified — continue to flight information",
      exact: true,
    })
    .click();
  const preflight = page.getByRole("dialog", {
    name: "Start flight · Flight information and preflight",
    exact: true,
  });
  await expect(preflight.getByLabel("Origin", { exact: true })).toHaveValue(
    "MZBZ",
  );
  await expect(
    preflight.getByLabel("Destination", { exact: true }),
  ).toHaveValue("KCHA");
  await preflight
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - HOUR_MS));
  await preflight.getByLabel("Fuel starting level (US gal)").fill("80");
  await preflight.getByLabel("Fuel quantity added (US gal)").fill("0");
  await preflight.getByLabel("Engine oil starting level (US qt)").fill("8");
  await preflight.getByLabel("Engine oil quantity added (US qt)").fill("0");
  await preflight
    .getByRole("button", { name: "Save preflight & start flight", exact: true })
    .click();
  await expect(preflight).not.toBeVisible();
  await row
    .getByRole("button", { name: "Start / resume flight", exact: true })
    .click();
  const ending = page.getByRole("dialog", { name: "End flight", exact: true });
  await expect(ending.getByLabel("Origin", { exact: true })).toHaveValue(
    "MZBZ",
  );
  await expect(ending.getByLabel("Destination", { exact: true })).toHaveValue(
    "KCHA",
  );
  await expect(ending.getByLabel("Ending Hobbs", { exact: false })).toHaveValue(
    "",
  );
  const start = Number(
    await ending.getByLabel("Starting Hobbs (hours)").inputValue(),
  );
  await ending
    .getByLabel("Ending Hobbs", { exact: false })
    .fill((start + 1).toFixed(1));
  await ending
    .getByRole("button", { name: "End flight & save", exact: true })
    .click();
  await expect(ending).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start / resume flight", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "MZBZ" })).toContainText(
    "KCHA",
  );
  await page.getByRole("link", { name: "Flight plans", exact: true }).click();
  await uploadIcaoPlan(page);
  await expect(dialog).toBeVisible();
  // Select a different aircraft to create a separate proposed plan.
  await saveForAircraft(dialog, 2);
  await page.getByLabel("Aircraft", { exact: true }).selectOption("");
  await expect(page.locator(".flight-plan-group-heading h2")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove from queue" }).click();
  await expect(page.locator(".flight-plan-table")).toHaveCount(0);
  await expect(
    page.getByText("Logged and removed plans", { exact: false }),
  ).toHaveCount(2);
  await page.screenshot({
    path: "/tmp/flight-plans-grouped.png",
    fullPage: true,
  });
});

async function uploadIcaoPlan(page: Page) {
  await page
    .getByLabel("Upload Flight Plan PDF")
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
}

/** Saves the imported plan for the aircraft at that option index. */
async function saveForAircraft(dialog: Locator, index: number) {
  await dialog.getByLabel("Aircraft", { exact: true }).selectOption({ index });
  await dialog
    .getByLabel("Aircraft differs from the PDF: confirm reassignment")
    .check();
  await dialog
    .getByRole("button", { name: "Save flight plan", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
