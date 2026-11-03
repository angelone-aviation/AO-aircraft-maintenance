import { test, expect, type Page } from "@playwright/test";
async function demo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}
test("offline flight and discrepancy persist across reload and synchronize once", async ({
  page,
  context,
}) => {
  await demo(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await expect(page.getByLabel("Starting Hobbs (hours)")).toHaveValue("2341.2");
  await expect(page.getByLabel("Starting tach (hours)")).toHaveValue("2261.2");
  await expect(page.getByLabel("Starting Hobbs (hours)")).not.toBeEditable();
  await expect(page.getByLabel("Starting tach (hours)")).not.toBeEditable();
  await page.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
  await page.getByLabel("Flight date & time").fill("2026-01-01T10:00");
  await page.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Offline inspection: oil leak under cowling");
  await page.getByRole("button", { name: "Save report" }).click();
  // Both entries must be queued before reloading.
  await expect(page.getByText("Offline · 2 pending")).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: /Sync center/ }).click();
  await expect(
    page.getByRole("heading", { name: "2 pending entries" }),
  ).toBeVisible();
  await expect(page.getByText("Awaiting sync", { exact: true })).toHaveCount(2);
  await context.setOffline(false);
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "0 pending entries" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "accepted", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await expect(
    page.getByText("Offline inspection: oil leak under cowling", {
      exact: true,
    }),
  ).toHaveCount(1);
});
test("conflicting flights require admin review and preserve audit evidence", async ({
  page,
  context,
}) => {
  await demo(page);
  await context.setOffline(true);
  for (const [time, meter] of [
    ["2026-01-01T10:00", "2342.2"],
    ["2026-01-02T10:00", "2343.2"],
  ]) {
    await page
      .getByRole("button", { name: "Log a flight", exact: true })
      .click();
    await page.getByLabel("Ending Hobbs *", { exact: true }).fill(meter);
    await page.getByLabel("Flight date & time").fill(time);
    await page
      .getByRole("button", { name: "Save flight", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await context.setOffline(false);
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Needs review", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByLabel("Explanation")
    .fill("Verified sequence against the pilot log.");
  await page.getByRole("button", { name: "Record review" }).click();
  await expect(
    page.getByRole("cell", { name: "accepted", exact: true }),
  ).toHaveCount(2);
  await page.getByRole("link", { name: "Change history", exact: true }).click();
  await expect(
    page.getByText("Verified sequence against the pilot log.", { exact: true }),
  ).toBeVisible();
});
test("mobile navigation, favorites and discrepancy resolution work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page
    .getByRole("button", { name: "Favorite N206MA", exact: true })
    .click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".dash-card")).toHaveCount(1);
  // Phone navigation lives in the bottom tab bar's "More" sheet.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Record resolution" }).click();
  await page
    .getByLabel("What fixed the problem?")
    .fill("Cleaned and secured the light connector.");
  await page.getByRole("button", { name: "Mark resolved" }).click();
  await page.getByLabel("Include resolved reports").check();
  await expect(
    page.getByText("Cleaned and secured the light connector."),
  ).toBeVisible();
});
test("seven-day expiry locks cached data without deleting pending entries", async ({
  page,
  context,
}) => {
  await demo(page);
  await context.setOffline(true);
  await page.getByRole("link", { name: "Discrepancies", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Preserve through expiry");
  await page.getByRole("button", { name: "Save report" }).click();
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("snapshots", "readwrite");
        const store = tx.objectStore("snapshots");
        const read = store.get("demo");
        read.onsuccess = () => {
          const s = read.result;
          s.authenticatedAt = Date.now() - 8 * 86400000;
          store.put(s, "demo");
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Time to reconnect." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Overview", exact: true }),
  ).not.toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my pending entries" }).click();
  expect((await download).suggestedFilename()).toBe(
    "angel-one-pending-entries.json",
  );
});
test("administration creates aircraft, groups and user access in demo", async ({
  page,
}) => {
  await demo(page);
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  await page.getByLabel("Full name").fill("Test Mechanic");
  await page.getByLabel("Email", { exact: true }).fill("mechanic@example.test");
  await page.getByLabel("Initial password").fill("demo-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Test Mechanic", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Permission groups", exact: true })
    .click();
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await page.getByLabel("Group name").fill("Maintenance crew");
  await page.getByRole("dialog").getByLabel("N206MA").check();
  await page.getByLabel("Resolve discrepancies online").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Maintenance crew", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Aircraft", exact: true }).click();
  await page.getByRole("button", { name: "Add aircraft", exact: true }).click();
  for (const [label, text] of [
    ["Registration", "N123TEST"],
    ["Make", "Cessna"],
    ["Model", "172"],
    ["Serial number", "TEST-001"],
    ["Current Hobbs (hours)", "100.0"],
    ["Current tach (hours)", "90.0"],
    ["Current landings", "100"],
  ])
    await page.getByLabel(label, { exact: true }).fill(text);
  // Cycles are only tracked for turbine aircraft.
  await expect(page.getByLabel("Current cycles", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add aircraft", exact: true })
    .click();
  await expect(page.getByText("N123TEST", { exact: true })).toBeVisible();
});

test("starting readings follow aircraft selection and show historical values when reviewing", async ({
  page,
}) => {
  await demo(page);
  await page.getByRole("button", { name: "Log a flight", exact: true }).click();
  await page.getByLabel("Aircraft", { exact: true }).selectOption("demo-208");
  await expect(page.getByLabel("Starting Hobbs (hours)")).toHaveValue("4218.6");
  await expect(page.getByLabel("Starting tach (hours)")).toHaveValue("4138.6");
  await page.getByLabel("Aircraft", { exact: true }).selectOption("demo-206");
  for (const [time, hobbs, tach] of [
    ["2026-01-01T10:00", "2342.2", "2262.2"],
    ["2026-01-02T10:00", "2343.2", "2263.2"],
  ]) {
    if (time.includes("01-02")) {
      await page
        .getByRole("button", { name: "Log a flight", exact: true })
        .click();
      await expect(page.getByLabel("Starting Hobbs (hours)")).toHaveValue(
        "2342.2",
      );
      await expect(page.getByLabel("Starting tach (hours)")).toHaveValue(
        "2262.2",
      );
    }
    await page.getByLabel("Flight date & time").fill(time);
    await page.getByLabel("Ending Hobbs *", { exact: true }).fill(hobbs);
    await page.getByLabel("Ending tach", { exact: true }).fill(tach);
    await page
      .getByRole("button", { name: "Save flight", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Entry synchronized successfully.",
    );
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  }
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  // Each meter column shows the ending reading above its starting reading.
  for (const heading of ["Hobbs", "Tach"])
    await expect(
      page.getByRole("columnheader", { name: heading, exact: true }),
    ).toBeVisible();
  const firstFlight = page.locator("tbody tr").last();
  await expect(
    firstFlight.getByRole("cell", {
      name: "2,342.2 from 2,341.2",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    firstFlight.getByRole("cell", {
      name: "2,262.2 from 2,261.2",
      exact: true,
    }),
  ).toBeVisible();
  await firstFlight
    .getByRole("button", { name: "Correct", exact: true })
    .click();
  await expect(page.getByLabel("Starting Hobbs (hours)")).toHaveValue("2341.2");
  await expect(page.getByLabel("Starting tach (hours)")).toHaveValue("2261.2");
  await expect(page.getByLabel("Starting Hobbs (hours)")).not.toBeEditable();
});
