/**
 * Responsibility: Pins what happens when two people change the same record:
 *   the stale-save review when the same inspection is saved from two tabs,
 *   Keep mine, and the change log that keeps both saves; and Edit and retry
 *   on a failed entry in the Sync center.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const REFERENCE = "TEST-STALE";
const THEIR_DESCRIPTION = "Changed in another tab";
const OVERRIDE_REASON = "Maintenance ferry approved by the director.";

test("saving an inspection two people changed shows the differences and keeps mine", async ({
  context,
}) => {
  await context.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  const mine = await context.newPage();
  await openDemo(mine);
  await createInspection(mine);
  await openDetails(mine);
  await mine.getByLabel("Repeat every (hours)", { exact: true }).fill("150");

  // The other person saves the same inspection while the form is open.
  const theirs = await context.newPage();
  await openDemo(theirs);
  await openDetails(theirs);
  await theirs
    .getByLabel("Description", { exact: true })
    .fill(THEIR_DESCRIPTION);
  await theirs
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(theirs.getByRole("dialog")).not.toBeVisible();
  await theirs.close();

  await mine
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  const review = mine.getByRole("dialog", {
    name: "Someone else changed this inspection",
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Alex Morgan saved this inspection");
  const description = review.getByRole("row", { name: /Description/ });
  await expect(description).toContainText("Changed by them");
  await expect(description).toContainText("Workshop check");
  await expect(description).toContainText(THEIR_DESCRIPTION);
  const interval = review.getByRole("row", { name: /Repeat every \(hours\)/ });
  await expect(interval).toContainText("Changed by you");
  await expect(interval).toContainText("150.0");
  await expect(interval).toContainText("100.0");
  await review.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(mine.getByRole("dialog")).toHaveCount(0);

  // Mine won whole: the interval moved the due time and the description is
  // back to what this tab saved.
  const row = mine.getByRole("row").filter({ hasText: REFERENCE });
  await expect(row).toContainText("2,450.0");
  await expect(row).toContainText("Workshop check");
  await mine.getByRole("link", { name: "Change history", exact: true }).click();
  await expect(
    mine.getByText("Inspection details updated.", { exact: true }),
  ).toHaveCount(2);
});

test("a failed entry can be edited and retried from the Sync center", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await openDemo(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  // A grounding report queued before the flight grounds the aircraft when
  // it syncs first, so the flight behind it is refused at the dispatch gate.
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Alternator inoperative after start");
  await page.getByRole("checkbox", { name: /Aircraft not airworthy/ }).check();
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await page.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
  await page.getByLabel("Flight date & time").fill("2026-01-01T10:00");
  await page.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await context.setOffline(false);

  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "1 pending entry" }),
  ).toBeVisible();
  await expect(
    page.locator(".rec-entry").getByText("Needs attention", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/N206MA is grounded/)).toBeVisible();
  await page.getByRole("button", { name: "Edit and retry" }).click();
  const retry = page.getByRole("dialog", { name: "Edit and retry flight" });
  await expect(retry.getByLabel("Ending Hobbs *", { exact: true })).toHaveValue(
    "2342.2",
  );
  await retry
    .getByLabel("Administrator dispatch override reason")
    .fill(OVERRIDE_REASON);
  await retry.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "accepted", exact: true }),
  ).toHaveCount(1);
});

async function openDemo(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

async function createInspection(page: Page) {
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page.getByRole("button", { name: "New inspection" }).click();
  await page.getByLabel("Reference", { exact: true }).fill(REFERENCE);
  await page.getByLabel("Description", { exact: true }).fill("Workshop check");
  await page.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await page.getByLabel("Repeat every (hours)", { exact: true }).fill("100");
  await page.getByLabel("Last complied at (tracked hours)").fill("2300");
  await page
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

async function openDetails(page: Page) {
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: REFERENCE })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Inspection details" }),
  ).toBeVisible();
}
