/**
 * Responsibility: Pins the shared UI motion: a dialog's open and closing
 *   echo and the Segmented control's sliding pill move on a mouse-and-
 *   keyboard screen, and nothing moves under prefers-reduced-motion.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const DESKTOP = { width: 1440, height: 1000 };
// --dur in src/styles/tokens.css: the open and slide time.
const OPEN_DURATION = "0.25s";

type EchoRecord = {
  hidden: string | null;
  inert: boolean;
  text: string;
  controls: number;
  onTop: boolean;
};

test("a dialog and the chip row move on a mouse-and-keyboard screen", async ({
  page,
}) => {
  await openFlights(page);
  const help = await openShortcuts(page);
  const panel = help.locator(".ds-dialog-panel");
  await expect(panel).toHaveCSS("animation-name", "pop");
  await expect(panel).toHaveCSS("animation-duration", OPEN_DURATION);

  await watchForEcho(page);
  await page.keyboard.press("Escape");
  // The dialog leaves the accessibility tree at once; only a picture of it
  // fades, holding nothing a person or a test could find or use.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const echo = await page.evaluate(
    () => (window as unknown as { echoes: EchoRecord[] }).echoes,
  );
  expect(echo).toEqual([
    { hidden: "true", inert: true, text: "", controls: 0, onTop: true },
  ]);
  await expect(page.locator(".ds-dialog-echo")).toHaveCount(0);

  const row = page.getByRole("group", { name: "Flight status" });
  const pill = row.locator(".ds-seg-pill");
  await expect(row).toHaveAttribute("data-sliding", "");
  await expect(pill).toHaveCSS(
    "transition-duration",
    `${OPEN_DURATION}, ${OPEN_DURATION}`,
  );
  const before = await pill.boundingBox();
  await row.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(pill).not.toHaveCSS("transform", "none");
  await expect
    .poll(async () => (await pill.boundingBox())!.x)
    .toBeGreaterThan(before!.x);
  const chosen = await row
    .getByRole("button", { name: "Rejected", exact: true })
    .boundingBox();
  // offsetLeft rounds to whole pixels.
  await expect
    .poll(async () => (await pill.boundingBox())!.x)
    .toBeCloseTo(chosen!.x, 0);
});

test("nothing moves under prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFlights(page);
  const help = await openShortcuts(page);
  await expect(help.locator(".ds-dialog-panel")).toHaveCSS(
    "animation-name",
    "none",
  );
  await watchForEcho(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const echoes = await page.evaluate(
    () => (window as unknown as { echoes: EchoRecord[] }).echoes,
  );
  expect(echoes).toEqual([]);

  const row = page.getByRole("group", { name: "Flight status" });
  await row.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(row).not.toHaveAttribute("data-sliding");
  await expect(row.locator(".ds-seg-pill")).toBeHidden();
  await expect(
    row.getByRole("button", { name: "Rejected", exact: true }),
  ).toHaveCSS("background-color", "rgb(37, 99, 235)");
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

async function openFlights(page: Page) {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flights");
  await expect(
    page.getByRole("group", { name: "Flight status" }),
  ).toBeVisible();
}

async function openShortcuts(page: Page) {
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  return help;
}

// The echo lives for about 150ms, so record it as it is added rather than
// racing to find it.
async function watchForEcho(page: Page) {
  await page.evaluate(() => {
    const echoes: EchoRecord[] = [];
    (window as unknown as { echoes: EchoRecord[] }).echoes = echoes;
    new MutationObserver((changes) => {
      for (const node of changes.flatMap((c) => [...c.addedNodes])) {
        if (!(node instanceof HTMLElement)) continue;
        if (!node.classList.contains("ds-dialog-echo")) continue;
        echoes.push({
          hidden: node.getAttribute("aria-hidden"),
          inert: node.inert,
          text: node.textContent ?? "",
          controls: node.querySelectorAll("button, input, a, select").length,
          onTop: node.matches(":popover-open"),
        });
      }
    }).observe(document.body, { childList: true });
  });
}
