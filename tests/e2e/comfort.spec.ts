/**
 * Responsibility: Pins the comfort features: the "Larger text" device
 *   setting, the waiting-to-send line, term tips, the Glossary page and the
 *   desktop keyboard shortcuts, at phone and desktop sizes.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
// The "Larger text" zoom in src/styles/largeText.css.
const TEXT_ZOOM = 1.18;

test("Larger text grows the interface on this device, survives a reload and fits a phone", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openDemo(page);
  const heading = page.getByRole("heading", { level: 1 });
  const normal = (await heading.boundingBox())!.height;
  await page.goto("/settings#device");
  const larger = page.getByRole("switch", { name: "Larger text" });
  await larger.check();
  await expect(page.locator("html")).toHaveClass(/\blarge-text\b/);
  await page.goto("/");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\blarge-text\b/);
  const grown = (await heading.boundingBox())!.height;
  expect(grown).toBeGreaterThanOrEqual(normal * TEXT_ZOOM - 1);
  expect(await sidewaysScroll(page)).toBe(false);
  await page.goto("/settings#device");
  await page.getByRole("switch", { name: "Larger text" }).uncheck();
  await expect(page.locator("html")).not.toHaveClass(/\blarge-text\b/);
});

test("the waiting-to-send line counts offline entries and links to the Sync center", async ({
  page,
  context,
}) => {
  await page.setViewportSize(PHONE);
  await openDemo(page, { offlineReady: true });
  const line = page.locator(".outbox-line [role=status]");
  await expect(line).toHaveText("");
  await context.setOffline(true);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Log flight" })
    .click();
  const start = await page.getByLabel("Starting Hobbs (hours)").inputValue();
  await page
    .getByLabel("Ending Hobbs *", { exact: true })
    .fill(String(Number(start) + 1));
  await page.getByLabel("Flight date & time").fill("2026-01-01T10:00");
  await page.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(line).toHaveText("1 entry waiting to send · Offline");
  await expect(line).toBeInViewport();
  await page.getByRole("link", { name: "See entries" }).click();
  await expect(
    page.getByRole("heading", { name: "1 pending entry" }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(line).toHaveText("");
});

for (const size of [PHONE, DESKTOP])
  test(`a term tip explains a word and opens the Glossary at it (${size.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openDemo(page);
    await page.goto("/airworthiness");
    const faa = page.getByRole("button", { name: "FAA, what it means" });
    await faa.focus();
    await page.keyboard.press("Enter");
    const tip = page.locator(".term-tip-pop:popover-open");
    await expect(tip).toContainText("Federal Aviation Administration");
    await expect(tip).toBeInViewport({ ratio: 1 });
    await expect(faa).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await faa.click();
    await tip.getByRole("link", { name: "See all terms" }).click();
    await expect(page).toHaveURL(/\/glossary#term-faa$/);
    await expect(page.locator("#term-faa")).toBeFocused();
    expect(await sidewaysScroll(page)).toBe(false);
  });

test("the Glossary searches, jumps by letter and opens at a linked term", async ({
  page,
}) => {
  await openDemo(page);
  await page.getByRole("link", { name: "Glossary", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Glossary" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search terms" }).fill("minimum");
  await expect(page.getByRole("status").filter({ hasText: "term" })).toHaveText(
    "1 term",
  );
  await expect(page.locator("#term-mel")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search terms" }).fill("");
  await page
    .getByRole("navigation", { name: "Jump to letter" })
    .getByRole("link", { name: "T", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "T", exact: true }),
  ).toBeInViewport();
  await page.goto("/glossary#term-ia");
  await expect(page.locator("#term-ia")).toBeFocused();
  await page
    .locator(".glossary-term.target dd")
    .getByRole("link", { name: "annual inspection" })
    .click();
  await expect(page).toHaveURL(/#term-annual$/);
  await expect(page.locator("#term-annual")).toBeFocused();
});

for (const view of ["owner portal", "board view"])
  test(`the ${view} reaches the Glossary from its one view`, async ({
    page,
  }) => {
    await openDemo(page);
    await page.getByRole("button", { name: `Preview ${view}` }).click();
    await page.getByRole("link", { name: "Glossary", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Glossary" })).toBeVisible();
    await expect(page.locator("#term-airworthy")).toBeAttached();
  });

test("keyboard shortcuts: / searches, n logs a flight, ? lists them, and typing or a dialog turns them off", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openDemo(page);
  await expect(page.getByText("for keyboard shortcuts")).toBeVisible();
  await page.keyboard.press("/");
  const search = page.locator('main input[type="search"]').first();
  await expect(search).toBeFocused();
  await search.fill("");
  await page.keyboard.type("n/");
  await expect(search).toHaveValue("n/");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await search.blur();
  await page.keyboard.press("Alt+n");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("n");
  const flight = page.getByRole("dialog", { name: "Log a flight" });
  await expect(flight).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(flight).toHaveCount(0);
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toContainText("Log a new flight");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("touch-only phones show no shortcut hint", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await openDemo(page);
  await expect(page.getByText("for keyboard shortcuts")).toHaveCount(0);
  await context.close();
});

async function openDemo(page: Page, options: { offlineReady?: boolean } = {}) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  const home = page.getByRole("heading", { name: "Your fleet, at a glance." });
  await expect(home).toBeVisible();
  if (!options.offlineReady) return;
  // The service worker must control the page before it can go offline.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(home).toBeVisible();
}

async function sidewaysScroll(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
}
