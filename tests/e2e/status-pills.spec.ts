/**
 * Responsibility: Pins one status pill everywhere and the shared row of the
 *   Settings integration panels, at phone and desktop sizes.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];
const INTEGRATIONS = [
  {
    section: "#system",
    name: "FAA API key and renewal",
    button: "Update FAA API key",
  },
  {
    section: "#system",
    name: "Address verification",
    button: "Update Geoapify API key",
  },
  {
    section: "#program",
    name: "Aircraft Spruce account",
    button: "Update Aircraft Spruce account",
  },
];

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("inspection schedules show sentence-case status pills", async ({
      page,
    }) => {
      await openDemo(page, "/");
      await page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: "N206MA" }) })
        .getByRole("button", { name: /View aircraft/ })
        .click();
      const schedules = page.getByRole("region", {
        name: "Inspection schedules",
      });
      await expect(
        schedules.locator(".ds-pill").filter({ hasText: /^Due soon$/ }),
      ).toBeVisible();
      await expect(page.locator(".badge")).toHaveCount(0);
    });

    test("each integration panel opens with its name, status pill and Update… button", async ({
      page,
    }) => {
      await openDemo(page, "/settings");
      for (const row of INTEGRATIONS) {
        const panel = page
          .locator(`${row.section} .set-integration`)
          .filter({ has: page.getByRole("heading", { name: row.name }) });
        await expect(panel.locator(".ds-pill")).toHaveText(/\S/);
        const update = panel.getByRole("button", { name: row.button });
        await expect(update).toHaveText("Update…");
        const box = (await update.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    });
  });
}

async function openDemo(page: Page, path: string) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
}
