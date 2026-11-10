/**
 * Responsibility: Pins the loading placeholders: a page whose code is still
 *   downloading, and the Overview's AD alerts, show card-shaped skeletons
 *   announced once as "Loading", still under reduced motion, then the content.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

// The service worker would answer from its cache, out of the test's reach.
test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("a page still loading shows a still skeleton, then the page", async ({
      page,
    }) => {
      const release = await holdChunk(page, /\/assets\/Vendors-[^/]+\.js$/);
      await openDemo(page, "/vendors");
      const loading = page.getByRole("status").filter({ hasText: "Loading" });
      await expect(loading).toHaveCount(1);
      await expect(loading.locator(".ds-skeleton-card").first()).toBeVisible();
      await expect(loading.locator(".ds-skeleton-card").first()).toHaveCSS(
        "animation-name",
        "none",
      );
      release();
      await expect(page.locator(".ds-skeleton")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });

    test("the Overview's AD alerts show a section skeleton while loading", async ({
      page,
    }) => {
      const release = await holdChunk(
        page,
        /\/assets\/Airworthiness-[^/]+\.js$/,
      );
      await openDemo(page, "/");
      const ads = page.locator(".dash-ads");
      await expect(ads.getByRole("status")).toHaveText("Loading");
      await expect(ads.locator(".ds-skeleton-card")).toHaveCount(1);
      release();
      await expect(ads.locator(".ds-skeleton")).toHaveCount(0);
      await expect(ads.getByRole("heading")).toBeVisible();
    });
  });
}

/** Holds the matching script until the returned function is called. */
async function holdChunk(page: Page, url: RegExp): Promise<() => void> {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route: Route) => {
    await held;
    await route.continue();
  });
  return () => release();
}

async function openDemo(page: Page, path: string) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
}
