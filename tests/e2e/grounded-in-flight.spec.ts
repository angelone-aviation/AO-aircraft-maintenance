/**
 * Responsibility: Pins that a flight the aircraft was grounded during can
 *   still be ended and saved, is held for review with the reason, and that a
 *   new flight cannot start on the grounded aircraft, at phone and desktop
 *   sizes.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const HOUR_MS = 3_600_000;
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const SHOTS = process.env.UX_SHOTS;

test.use({ deviceScaleFactor: 2 });

for (const viewport of VIEWPORTS) {
  test(`a flight grounded after take-off is saved and held (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await page.goto("/flights");
    await startFlight(page);
    await reportGroundingProblem(page);

    await page.goto("/flights");
    await page
      .getByRole("button", { name: "End flight", exact: true })
      .first()
      .click();
    const ending = page.getByRole("dialog", {
      name: "End flight",
      exact: true,
    });
    await expect(ending).toContainText("was grounded during this flight.");
    const start = Number(
      await ending.getByLabel("Starting Hobbs (hours)").inputValue(),
    );
    await ending
      .getByLabel("Ending Hobbs", { exact: false })
      .fill((start + 1).toFixed(1));
    await shoot(page, `grounded-in-flight-end-${viewport.name}`);
    await ending
      .getByRole("button", { name: "End flight & save", exact: true })
      .click();
    await expect(ending).not.toBeVisible();
    await expect(
      page.getByText(
        "Entry synced and held for administrator review. Aircraft totals are unchanged.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/MIDFLT/).first()).toBeVisible();

    // Starting a new flight on the grounded aircraft is still blocked.
    const preflight = await openPreflight(page);
    await expect(preflight).toContainText("N206MA is grounded.");
    // The demo user is an administrator: only a recorded override releases it.
    await expect(
      preflight.getByLabel("Administrator dispatch override reason"),
    ).toBeVisible();
  });
}

async function startFlight(page: Page) {
  const preflight = await openPreflight(page);
  await preflight
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - HOUR_MS));
  await preflight.getByLabel("Origin", { exact: true }).fill("MIDFLT");
  for (const [label, value] of [
    ["Fuel starting level (US gal)", "80"],
    ["Fuel quantity added (US gal)", "0"],
    ["Engine oil starting level (US qt)", "8"],
    ["Engine oil quantity added (US qt)", "0"],
  ])
    await preflight.getByLabel(label).fill(value);
  await preflight
    .getByRole("button", { name: "Save preflight & start flight", exact: true })
    .click();
  await expect(preflight).not.toBeVisible();
}

async function openPreflight(page: Page) {
  await page
    .getByRole("button", { name: /^Start flight/ })
    .first()
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
  return page.getByRole("dialog", {
    name: "Start flight · Flight information and preflight",
    exact: true,
  });
}

async function reportGroundingProblem(page: Page) {
  await page.goto("/discrepancies");
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Nose gear shimmy on landing roll");
  await page.getByRole("checkbox", { name: /Aircraft not airworthy/ }).check();
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

function localDateTime(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

// Screenshots for review, in both themes, only when UX_SHOTS names a folder.
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const dark of [false, true]) {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      dark,
    );
    const theme = dark ? "dark" : "light";
    await page.screenshot({
      path: `${SHOTS}/behaviour-${name}-${theme}.png`,
      animations: "disabled",
    });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}
