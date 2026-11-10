/**
 * Responsibility: Pins that an aircraft whose setup has gaps reads "Setup
 *   incomplete" with the gaps named, never Airworthy, on the Overview card
 *   and detail, the Aircraft page and the board view, at phone and desktop
 *   sizes, and that the set-up demo aircraft read Due soon and Airworthy.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const SHOTS = process.env.UX_SHOTS;

test.use({ deviceScaleFactor: 2 });

for (const viewport of VIEWPORTS) {
  test(`an aircraft still being set up reads Setup incomplete (${viewport.name})`, async ({
    page,
  }) => {
    await openDemo(page, viewport);
    // N182MA is left mid-setup: no components and no reviewed AD.
    const card = page.getByRole("article", { name: "N182MA", exact: true });
    await expect(card).toContainText("Setup incomplete");
    await expect(card).not.toContainText("Airworthy");
    await expect(card).toContainText("Components missing");
    await card.scrollIntoViewIfNeeded();
    await shoot(page, `setup-incomplete-overview-${viewport.name}`);

    await card
      .getByRole("button", { name: "View aircraft", exact: true })
      .click();
    const notes = page.getByRole("list", { name: "N182MA status notes" });
    await expect(notes).toContainText("Components missing");
    await expect(notes).toContainText("ADs not reviewed");
    await expect(page.locator(".dash-detail-pill")).toHaveText(
      "Setup incomplete",
    );
    await shoot(page, `setup-incomplete-detail-${viewport.name}`);
    await page.getByRole("button", { name: "Close dialog" }).click();

    await page.goto("/aircraft");
    const chips = page.getByLabel("N182MA setup", { exact: true });
    await expect(chips).toContainText("Components missing");
    await expect(
      page.locator(".ds-pill", { hasText: "Setup incomplete" }).first(),
    ).toBeVisible();
    await shoot(page, `setup-incomplete-aircraft-${viewport.name}`);

    await page.goto("/board");
    await expect(
      page.locator(".ds-kpi-label", { hasText: "Setup incomplete" }),
    ).toBeVisible();
    await shoot(page, `setup-incomplete-board-${viewport.name}`);
  });
}

test("the set-up demo aircraft read as before", async ({ page }) => {
  await openDemo(page, VIEWPORTS[1]);
  const n208 = page.getByRole("article", { name: "N208MA", exact: true });
  await expect(n208).toContainText("Airworthy");
  await expect(n208).not.toContainText("Setup incomplete");
  const n206 = page.getByRole("article", { name: "N206MA", exact: true });
  await expect(n206).toContainText("Due soon");
  await expect(n206).not.toContainText("Setup incomplete");
});

async function openDemo(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("article", { name: "N208MA", exact: true }),
  ).toBeVisible();
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
