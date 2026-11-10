/**
 * Responsibility: Pins that an aircraft's detail header draws its own type,
 *   chosen by make and model, and that the drawing loads.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];
const DEMO_FLEET = [
  { registration: "N206MA", art: "/branding/aircraft-high-wing.svg" },
  { registration: "N208MA", art: "/branding/aircraft-caravan.svg" },
  { registration: "N182MA", art: "/branding/aircraft-high-wing.svg" },
];

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("each aircraft's detail header draws its type", async ({ page }) => {
      await page.addInitScript(() =>
        sessionStorage.setItem("angel-one-demo", "true"),
      );
      await page.goto("/");
      for (const { registration, art } of DEMO_FLEET) {
        await openDetail(page, registration);
        const drawing = page.locator(".dash-detail-art");
        await expect(drawing).toHaveAttribute("src", art);
        await expect(drawing).toHaveAttribute("alt", "");
        await expect
          .poll(() =>
            drawing.evaluate((img: HTMLImageElement) => img.naturalWidth),
          )
          .toBeGreaterThan(0);
        await page.getByRole("button", { name: "Close dialog" }).click();
      }
    });
  });
}

async function openDetail(page: Page, registration: string) {
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", { name: registration, exact: true }),
    })
    .getByRole("button", { name: /View aircraft/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
