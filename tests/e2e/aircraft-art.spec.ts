/**
 * Responsibility: Pins that every aircraft's detail header shows the one
 *   aircraft picture: sized, lazy, hidden from screen readers, with a fine
 *   drop shadow, and that the picture loads.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];
const DEMO_FLEET = ["N206MA", "N208MA", "N182MA"];
const PICTURE = "/branding/aircraft.webp";
// The picture's proportions (640 x 250), which its width and height keep.
const PICTURE_RATIO = 2.56;

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("each aircraft's detail header shows the aircraft picture", async ({
      page,
    }) => {
      await page.addInitScript(() =>
        sessionStorage.setItem("angel-one-demo", "true"),
      );
      await page.goto("/");
      for (const registration of DEMO_FLEET) {
        await openDetail(page, registration);
        const picture = page.locator(".dash-detail-art");
        await expect(picture).toHaveAttribute("src", PICTURE);
        await expect(picture).toHaveAttribute("alt", "");
        await expect(picture).toHaveAttribute("aria-hidden", "true");
        await expect(picture).toHaveAttribute("loading", "lazy");
        await expect
          .poll(() =>
            picture.evaluate((img: HTMLImageElement) => img.naturalWidth),
          )
          .toBeGreaterThan(0);
        const drawn = await picture.evaluate((img: HTMLImageElement) => ({
          ratio: img.width / img.height,
          filter: getComputedStyle(img).filter,
        }));
        expect(drawn.ratio).toBeCloseTo(PICTURE_RATIO, 1);
        expect(drawn.filter).toContain("drop-shadow");
        await page.getByRole("button", { name: "Close dialog" }).click();
      }
    });
  });
}

test("no line drawings are left in the build", async ({ request }) => {
  for (const drawing of [
    "aircraft-high-wing.svg",
    "aircraft-caravan.svg",
    "aircraft-twin.svg",
    "aircraft-generic.svg",
    "cessna-oblique.svg",
  ]) {
    const response = await request.get(`/branding/${drawing}`);
    // The static server answers unknown paths with the app shell, as the
    // production host does; a real drawing would be served as SVG.
    expect(response.headers()["content-type"] ?? "").not.toContain("svg");
  }
});

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
