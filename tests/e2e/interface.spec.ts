/**
 * Responsibility: Pins the shell's and the shared dialog's interface: nested
 *   Escape, focus kept clear of sticky footers, focus-ring contrast, the Job
 *   cards link, the sections sheet, the theme before first paint, a theme
 *   switch with no half-faded surfaces, and the chosen chip's label under
 *   the pointer.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * Regression tests for the interface bugs (ui-*) of the 2026-11-03 bug hunt,
 * docs/qa/bug-hunt-2026-11-03/README.md.
 */
import { test, expect, type Page } from "@playwright/test";

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
// Upper bounds on Tab presses, so a focus trap fails a test instead of
// hanging it.
const DIALOG_TAB_LIMIT = 90;
const SIDEBAR_TAB_LIMIT = 40;
// WCAG 2.2 focus indicators: at least 2 CSS px thick (SC 2.4.13) and 3:1
// against adjacent colours (SC 1.4.11).
const FOCUS_RING_MIN_WIDTH_PX = 2;
const FOCUS_RING_MIN_CONTRAST = 3;
// WCAG 2.2 text contrast (SC 1.4.3).
const TEXT_MIN_CONTRAST = 4.5;

const pilot = {
  id: "pilot-only",
  name: "Pilots",
  permissions: ["read", "flight", "discrepancy"],
};

test.describe("Escape in a nested dialog (ui-1)", () => {
  test("closes only the address dialog and keeps the purchase order draft", async ({
    page,
  }) => {
    await demo(page, "/purchase-orders");
    await page.getByRole("button", { name: "New PO", exact: true }).click();
    const po = page.getByRole("dialog", {
      name: "New purchase order",
      exact: true,
    });
    await po.getByLabel("Vendor", { exact: true }).fill("Acme Aviation Supply");
    await po.getByLabel("Part 1 number", { exact: true }).fill("PN-12345");
    await po
      .getByRole("button", { name: "Add new address", exact: true })
      .click();
    const address = page.getByRole("dialog", {
      name: "Add new shipping address",
      exact: true,
    });
    await expect(address).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(address).toHaveCount(0);
    await expect(po).toBeVisible();
    await expect(po.getByLabel("Vendor", { exact: true })).toHaveValue(
      "Acme Aviation Supply",
    );
    await expect(po.getByLabel("Part 1 number", { exact: true })).toHaveValue(
      "PN-12345",
    );
    // The next Escape belongs to the purchase order itself, which asks
    // before discarding what was typed in it.
    page.once("dialog", (question) => void question.accept());
    await page.keyboard.press("Escape");
    await expect(po).toHaveCount(0);
  });

  test("closes My certifications and keeps the phone More sheet open", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await demo(page);
    await page.getByRole("button", { name: "More", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "All sections" });
    await sheet
      .getByRole("button", { name: "My certifications", exact: true })
      .click();
    const certifications = page.getByRole("dialog", {
      name: "My certifications",
    });
    await expect(certifications).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(certifications).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("Tab keeps dialog fields clear of the sticky footer (ui-3)", () => {
  for (const c of [
    {
      name: "Log a flight on a 320px phone",
      viewport: { width: 320, height: 640 },
      path: "/",
      open: (page: Page) =>
        page
          .getByRole("navigation", { name: "Primary" })
          .getByRole("button", { name: "Log flight" })
          .click(),
    },
    {
      name: "New inspection on a phone",
      viewport: PHONE,
      path: "/inspections",
      open: (page: Page) =>
        page.getByRole("button", { name: "New inspection" }).click(),
    },
    {
      name: "New purchase order on desktop",
      viewport: DESKTOP,
      path: "/purchase-orders",
      open: (page: Page) =>
        page.getByRole("button", { name: "New PO", exact: true }).click(),
    },
  ])
    test(c.name, async ({ page }) => {
      await page.setViewportSize(c.viewport);
      await demo(page, c.path);
      await c.open(page);
      await expect(page.locator("dialog[open] .form-footer")).toBeVisible();
      expect(await focusedUnderFooter(page)).toEqual([]);
    });
});

test("Tab down the desktop sidebar keeps each link clear of the profile footer (ui-7)", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await demo(page);
  await page.locator(".sidebar .brand").focus();
  const hidden: string[] = [];
  for (let i = 0; i < SIDEBAR_TAB_LIMIT; i++) {
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      if (!a.closest(".sidebar")) return "out";
      if (a.closest(".profile")) return null;
      const profile = document.querySelector(".sidebar .profile")!;
      return a.getBoundingClientRect().bottom >
        profile.getBoundingClientRect().top + 0.5
        ? a.textContent!.trim()
        : null;
    });
    if (result === "out") break;
    if (result) hidden.push(result);
  }
  expect(hidden).toEqual([]);
});

test("sidebar links draw an unclipped focus ring with 3:1 contrast in both themes (ui-6)", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await demo(page);
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page
        .getByRole("button", { name: "Switch to dark theme", exact: true })
        .click();
    for (const href of ["/", "/flights", "/discrepancies"]) {
      await page.locator(`.sidebar nav a[href='${href}']`).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const cs = getComputedStyle(a);
        return {
          focusVisible: a.matches(":focus-visible"),
          style: cs.outlineStyle,
          width: parseFloat(cs.outlineWidth),
          offset: parseFloat(cs.outlineOffset),
          color: cs.outlineColor,
          link: cs.backgroundColor,
          sidebar: getComputedStyle(a.closest("aside")!).backgroundColor,
        };
      });
      expect(ring.focusVisible).toBe(true);
      expect(ring.style).not.toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(FOCUS_RING_MIN_WIDTH_PX);
      // Drawn inside the link, so the collapsible group's overflow cannot
      // clip it.
      expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
      expect(contrast(ring.color, ring.sidebar)).toBeGreaterThanOrEqual(
        FOCUS_RING_MIN_CONTRAST,
      );
      // Inside the link the ring also meets the link's own (translucent)
      // fill; "/" is the active link here.
      expect(
        contrast(ring.color, over(ring.link, ring.sidebar)),
      ).toBeGreaterThanOrEqual(FOCUS_RING_MIN_CONTRAST);
    }
  }
});

test("the chosen chip keeps a readable label under the pointer", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  // With and without the sliding pill, which reduced motion turns off.
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await demo(page, "/flights");
    const chosen = page
      .getByRole("group", { name: "Flight status" })
      .getByRole("button", { name: "All flights", exact: true });
    await chosen.hover();
    const colours = await chosen.evaluate((b) => ({
      text: getComputedStyle(b).color,
      fill: getComputedStyle(b.parentElement!.firstElementChild!)
        .backgroundColor,
      own: getComputedStyle(b).backgroundColor,
    }));
    const fill =
      colours.own === "rgba(0, 0, 0, 0)" ? colours.fill : colours.own;
    expect(contrast(colours.text, fill)).toBeGreaterThanOrEqual(
      TEXT_MIN_CONTRAST,
    );
  }
});

test.describe("Job cards navigation (ui-4)", () => {
  test("the sidebar lists Job cards under Maintain", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await demo(page);
    await page
      .locator("#nav-group-maintain")
      .getByRole("link", { name: "Job cards", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Job cards", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".topbar-title")).toHaveText("Job cards");
    await expect(
      page.getByRole("button", { name: "New job card", exact: true }),
    ).toBeVisible();
  });

  for (const [w, h, button] of [
    [900, 1100, "All sections"],
    [390, 844, "More"],
  ] as const)
    test(`the ${button} sheet lists Job cards at ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await demo(page);
      await page.getByRole("button", { name: button, exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "All sections" });
      await sheet
        .getByRole("navigation", { name: "Maintain" })
        .getByRole("link", { name: "Job cards", exact: true })
        .click();
      await expect(sheet).toHaveCount(0);
      await expect(
        page.getByRole("heading", { level: 1, name: "Job cards", exact: true }),
      ).toBeVisible();
    });

  test("pilots and the owner view do not get the link", async ({ page }) => {
    await demo(page);
    await expect(
      page.getByRole("link", { name: "Job cards", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Preview owner portal", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your aircraft", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Job cards", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Exit owner preview", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Job cards", exact: true }),
    ).toBeVisible();
    await becomeMember(page, pilot);
    await expect(
      page.getByRole("link", { name: "Flight log", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Job cards", exact: true }),
    ).toHaveCount(0);
  });
});

test("the All sections sheet stays closed after the window passes through desktop width (ui-5)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1366 });
  await demo(page);
  const sheet = page.getByRole("dialog", { name: "All sections" });
  const sheetButton = page.getByRole("button", {
    name: "All sections",
    exact: true,
  });
  await sheetButton.click();
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 1024 });
  await expect(sheet).toHaveCount(0);
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Vendors", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Vendors", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 1366 });
  await expect(sheetButton).toBeVisible();
  await expect(sheet).toHaveCount(0);
  // It still opens on request.
  await sheetButton.click();
  await expect(sheet).toBeVisible();
});

test("a theme switch repaints every colour at once, in both directions", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await demo(page);
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
  expect(await fadingAfterThemeSwitch(page, "Switch to dark theme")).toEqual(
    [],
  );
  expect(await fadingAfterThemeSwitch(page, "Switch to light theme")).toEqual(
    [],
  );
});

test.describe("theme before first paint (ui-2)", () => {
  /** Records whether <html> is dark when the parser inserts <body>. The app's
   * module script runs only after parsing, so a theme it applies paints at
   * least one frame in the wrong palette. */
  async function recordThemeAtBody(
    page: Page,
    saved?: "dark" | "light" | "system",
  ) {
    await page.addInitScript((theme) => {
      sessionStorage.setItem("angel-one-demo", "true");
      if (theme && !sessionStorage.getItem("theme-seeded")) {
        localStorage.setItem("angelone-theme", theme);
        sessionStorage.setItem("theme-seeded", "true");
      }
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        (window as unknown as { darkAtBody: boolean }).darkAtBody =
          document.documentElement.classList.contains("dark");
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }, saved);
  }
  const darkAtBody = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { darkAtBody?: boolean }).darkAtBody,
    );
  const ready = (page: Page) =>
    expect(
      page.getByRole("heading", { name: "Your fleet, at a glance." }),
    ).toBeVisible();

  test("a saved dark theme applies before the body, online and offline", async ({
    page,
    context,
  }) => {
    await recordThemeAtBody(page, "dark");
    await page.goto("/");
    await ready(page);
    expect(await darkAtBody(page)).toBe(true);
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    // The early theme script is precached, so offline reloads keep it.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const precached = await page.evaluate(async () => {
      for (const name of await caches.keys())
        if (
          await (
            await caches.open(name)
          ).match("/theme-init.js", { ignoreSearch: true })
        )
          return true;
      return false;
    });
    expect(precached).toBe(true);
    await page.reload();
    await ready(page);
    await context.setOffline(true);
    await page.reload();
    await ready(page);
    expect(await darkAtBody(page)).toBe(true);
    await context.setOffline(false);
  });

  test("the system preference applies early when nothing is saved, and a saved light theme wins", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await recordThemeAtBody(page);
    await page.goto("/");
    await ready(page);
    expect(await darkAtBody(page)).toBe(true);
    await page.evaluate(() => localStorage.setItem("angelone-theme", "light"));
    await page.reload();
    await ready(page);
    expect(await darkAtBody(page)).toBe(false);
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  });

  test("a saved Match this device applies the device's dark setting before the body (B9)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await recordThemeAtBody(page, "system");
    await page.goto("/");
    await ready(page);
    expect(await darkAtBody(page)).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  });
});

async function demo(page: Page, path = "/") {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
}

/**
 * Switches the theme with the named toggle and lists the elements whose
 * colours still change after the first two frames: a surface fading while the
 * rest of the page has already switched leaves light and dark mixed.
 *
 * @returns Each such element as `tag.class`, once; empty when none.
 */
async function fadingAfterThemeSwitch(page: Page, toggleName: string) {
  return page.evaluate(async (name) => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    const colours = (el: Element) => {
      const cs = getComputedStyle(el);
      return [cs.backgroundColor, cs.color, cs.borderTopColor, cs.fill].join();
    };
    document
      .querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
      .click();
    await frame();
    await frame();
    const elements = [...document.querySelectorAll("body, body *")];
    const early = elements.map(colours);
    // A transition that a later style change cancels rejects `finished`; it
    // has stopped either way, which is all the wait needs.
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished.catch(() => undefined)),
    );
    const fading = elements.filter(
      (el, i) => el.isConnected && colours(el) !== early[i],
    );
    const names = fading.map((el) =>
      [el.localName, ...(el.getAttribute("class") ?? "").split(/\s+/)]
        .filter(Boolean)
        .join("."),
    );
    return [...new Set(names)];
  }, toggleName);
}

/**
 * Tabs through the open dialog and lists every focused control that ended up
 * under the dialog's stuck form footer. A text area only has to show its
 * first lines: the browser reveals its caret, not the whole box.
 */
async function focusedUnderFooter(page: Page) {
  const hidden: string[] = [];
  for (let i = 0; i < DIALOG_TAB_LIMIT; i++) {
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a?.closest("dialog")) return "out";
      const body = a.closest(".ds-dialog-body");
      if (!body) return null;
      const footer = [...body.querySelectorAll<HTMLElement>(".form-footer")]
        .filter((f) => getComputedStyle(f).position === "sticky")
        .pop();
      if (!footer || footer.contains(a)) return null;
      const field = a.getBoundingClientRect();
      if (!field.height) return null;
      const shown =
        a.tagName === "TEXTAREA" ? Math.min(field.height, 40) : field.height;
      if (field.top + shown <= footer.getBoundingClientRect().top + 0.5)
        return null;
      return (
        (a as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
        a.getAttribute("aria-label") ||
        a.textContent?.trim() ||
        a.tagName
      );
    });
    if (result === "out") break;
    if (result) hidden.push(result);
  }
  return hidden;
}

/**
 * Replaces the demo user's access with one permission group in the demo
 * program (stored snapshot, like the pilot-view and settings specs).
 */
async function becomeMember(page: Page, group: typeof pilot) {
  await page.evaluate(async (g) => {
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
      const s = entry.value;
      s.groups.push({ ...g, programUuid: "demo-program", aircraftIds: [] });
      s.user = {
        ...s.user,
        isAdmin: false,
        groupIds: [g.id],
        activeProgramUuid: "demo-program",
      };
      s.members = s.members.map((m: { id: string }) =>
        m.id === s.user.id ? s.user : m,
      );
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, group);
  await page.reload();
}

function luminance(rgb: string) {
  const [r, g, b] = rgb
    .match(/\d+(\.\d+)?/g)!
    .slice(0, 3)
    .map(Number)
    .map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// The WCAG contrast ratio of two rgb() colours.
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** A CSS rgb()/rgba() colour composited over an opaque rgb() backdrop. */
function over(top: string, backdrop: string) {
  const [r, g, b, a = 1] = top.match(/\d+(\.\d+)?/g)!.map(Number);
  const base = backdrop.match(/\d+(\.\d+)?/g)!.map(Number);
  const mix = [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)));
  return `rgb(${mix.join(", ")})`;
}
