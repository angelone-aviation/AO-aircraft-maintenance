/**
 * Responsibility: Pins the layout on phones and tablets: every route, in both
 *   themes, with normal and larger text, at three phone sizes, a landscape
 *   phone and two tablet sizes, with a 60-character unbroken word in the
 *   records, never scrolls the page sideways and keeps its navigation on
 *   screen; and a dialog on a short screen keeps the focused field visible.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * A long part number, name or reference used to make a page wider than a
 * phone and push the bottom tab bar off-screen (finding UI-1). Wide tables
 * must scroll inside their own container instead.
 */
import { test, expect, type Page } from "@playwright/test";

const LONG_WORD = "W".repeat(60);
// Free-text fields people fill in: names, models, references, notes. Ids,
// numbers and dates stay as they are, so the demo still loads.
const TEXT_KEYS = new Set([
  "name",
  "make",
  "model",
  "reference",
  "description",
  "title",
  "label",
  "notes",
  "remarks",
  "origin",
  "destination",
  "resolution",
  "contactName",
]);
const VIEWPORTS = [
  { name: "phone 360", width: 360, height: 780 },
  { name: "phone 375", width: 375, height: 667 },
  { name: "phone 390", width: 390, height: 844 },
  { name: "landscape phone", width: 844, height: 390 },
  { name: "tablet portrait", width: 820, height: 1180 },
  { name: "tablet landscape", width: 1180, height: 820 },
];
// Below this width the shell shows the bottom tab bar (AppShell).
const PHONE_MAX_WIDTH = 759;
const DEMO_AIRCRAFT = "demo-206";
const KEYBOARD_OPEN = { width: 375, height: 330 };
const ROUTES = [
  "/",
  "/flight-plans",
  "/checklists",
  "/flights",
  "/discrepancies",
  "/inspections",
  "/planning",
  "/planning/calendar",
  "/airworthiness",
  "/work-orders",
  "/task-cards",
  "/inspection-templates",
  "/components",
  "/components/imported",
  "/inventory",
  "/parts-requests",
  "/purchase-orders",
  "/vendors",
  "/costs",
  "/saved-addresses",
  "/manuals",
  "/aircraft",
  "/aircraft/setup",
  `/aircraft/setup/${DEMO_AIRCRAFT}?step=inspections`,
  `/aircraft/setup/${DEMO_AIRCRAFT}?step=review`,
  "/programs",
  "/sync",
  "/history",
  "/alerts",
  "/admin",
  "/settings",
  "/board",
  "/glossary",
  "/no-such-page",
];

const LOOKS = (["light", "dark"] as const).flatMap((theme) =>
  [false, true].map((largeText) => ({ theme, largeText })),
);

for (const { theme, largeText } of LOOKS)
  test(`every route fits phones and tablets in the ${theme} theme${largeText ? " with larger text" : ""}`, async ({
    page,
  }) => {
    test.setTimeout(ROUTES.length * 15_000);
    await openDemo(page, theme, largeText);
    await injectLongWord(page);
    const problems: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route);
      // The screen's code and its stylesheet load on demand.
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("Opening page…")).toHaveCount(0);
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await settle(page);
        problems.push(
          ...(await layoutProblems(page)).map(
            (p) => `${route} at ${viewport.name}: ${p}`,
          ),
        );
      }
    }
    expect(problems).toEqual([]);
  });

test("Start flight keeps the field being typed in on a short screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openDemo(page, "light");
  await page.goto("/flights");
  await page.getByRole("button", { name: "Start flight" }).first().click();
  const dialog = page.locator("dialog[open]");
  for (const box of await dialog.locator("input[type=checkbox]").all())
    await box.check();
  await dialog.getByRole("button", { name: /continue/i }).click();
  // An on-screen keyboard that resizes the page leaves about this much.
  await page.setViewportSize(KEYBOARD_OPEN);
  const origin = dialog.getByLabel("Origin");
  await origin.focus();
  expect(
    await origin.evaluate((field) => {
      const box = field.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return box.bottom <= window.innerHeight && hit === field;
    }),
  ).toBe(true);
});

async function openDemo(
  page: Page,
  theme: "light" | "dark",
  largeText = false,
) {
  await page.addInitScript(
    ({ t, large }) => {
      sessionStorage.setItem("angel-one-demo", "true");
      localStorage.setItem("angelone-theme", t);
      if (large) localStorage.setItem("angelone-large-text", "on");
    },
    { t: theme, large: largeText },
  );
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  const html = page.locator("html");
  await expect(html).toHaveClass(
    theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
  );
  if (largeText) await expect(html).toHaveClass(/\blarge-text\b/);
}

// Adds the long word to every free-text field of every stored snapshot, then
// reloads so the app reads them back.
async function injectLongWord(page: Page) {
  await page.evaluate(
    async ({ word, keys }) => {
      const textKeys = new Set(keys);
      const lengthen = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(lengthen);
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        for (const [key, field] of Object.entries(record))
          if (textKeys.has(key) && typeof field === "string" && field)
            record[key] = `${field} ${word}`;
          else lengthen(field);
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("angel-one-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction("snapshots", "readwrite");
      const cursor = tx.objectStore("snapshots").openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        lengthen(entry.value);
        entry.update(entry.value);
        entry.continue();
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { word: LONG_WORD, keys: [...TEXT_KEYS] },
  );
  await page.reload();
  await expect(page.getByText(LONG_WORD).first()).toBeAttached();
}

// Waits for the transitions a resize starts (the sidebar giving way to the
// rail or the tab bar) to end; endless decorative animations are ignored.
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== "running" ||
          a.effect?.getTiming().iterations === Infinity,
      ),
  );
}

// What is wrong with the layout at the current size: a page wider than the
// window, or navigation outside it.
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate((phoneMax) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const found: string[] = [];
    // Measured against clientWidth, in the page's own pixels like
    // scrollWidth: the "Larger text" zoom makes them differ from the window's.
    const pageWidth = document.documentElement.scrollWidth;
    if (pageWidth > document.documentElement.clientWidth)
      found.push(`page is ${pageWidth}px wide (${widestElement(width)})`);
    const offscreen = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
        const box = el.getBoundingClientRect();
        if (!box.width) return false;
        return box.left < 0 || box.right > width || box.bottom > height;
      }).length;
    const tabs = width <= phoneMax ? offscreen(".tabbar > *") : 0;
    if (tabs) found.push(`${tabs} bottom navigation items off-screen`);
    const rail = width > phoneMax ? offscreen(".rail-more") : 0;
    if (rail) found.push("All sections button off-screen");
    return found;

    // The innermost element reaching past the window, to name in a failure.
    function widestElement(limit: number) {
      const past = [...document.querySelectorAll<HTMLElement>("body *")].filter(
        (el) =>
          el.getBoundingClientRect().right > limit &&
          ![...el.children].some(
            (c) => c.getBoundingClientRect().right > limit,
          ),
      );
      return past
        .slice(0, 3)
        .map(
          (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`,
        )
        .join(", ");
    }
  }, PHONE_MAX_WIDTH);
}
