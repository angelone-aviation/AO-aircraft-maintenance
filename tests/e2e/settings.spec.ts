/**
 * Responsibility: Pins Settings: the sections each role sees, the panels moved
 *   out of Administration, Costs and Vendors working from Settings, deep
 *   links, the theme and alert digest, and reaching it on a phone.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * Settings changes how the app behaves; Administration decides who can do
 * what.
 */
import { test, expect, type Page } from "@playwright/test";

const SECTIONS = ["My account", "This device", "Flight Program", "System"];
const PHONE = { width: 390, height: 844 };
const PROGRAM_ADMIN: MemberGroup = {
  id: "program-admin",
  name: "Program administrators",
  permissions: ["read"],
  programAdmin: true,
};
const PILOT: MemberGroup = {
  id: "pilot-only",
  name: "Pilots",
  permissions: ["read", "flight", "discrepancy"],
};

test("system administrators see all four sections with the moved panels", async ({
  page,
}) => {
  await openDemo(page);
  await expectSettings(page);
  await expectSections(page, SECTIONS);
  for (const heading of [
    "Certifications",
    "Alert email",
    "Theme",
    "Offline data",
    "Program details",
    "Default labor rate",
    "Aircraft Spruce account",
    "FAA API key and renewal",
    "Address verification",
    "Off-site backups",
    "Full demo backup for cloud transfer",
  ])
    await expect(
      page.getByRole("heading", { level: 3, name: heading, exact: true }),
    ).toBeVisible();
  // Both CSV extracts say they are partial and not a backup.
  for (const section of ["#program", "#system"]) {
    const extract = page
      .locator(section)
      .getByRole("region", { name: "CSV extract (partial)", exact: true });
    await expect(extract).toContainText("It is not a backup");
  }
  await expect(page.getByText("See “Deployment” in the README.")).toBeVisible();
  // The nightly off-site backup is recorded only by the production job.
  await expect(
    page
      .locator("#system")
      .getByText("Off-site backups run only on the production deployment.", {
        exact: true,
      }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .locator("#system")
    .getByRole("button", { name: "Download aircraft.csv", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(
    /^angel-one-aircraft-.+\.csv$/,
  );
  // Settings is the last Manage link and sits beside My certifications.
  await expect(page.locator("#nav-group-manage a").last()).toHaveText(
    "Settings",
  );
  await expect(
    page.getByRole("link", { name: "Administration", exact: true }),
  ).toBeVisible();
  const footer = page.locator(".profile-links");
  await expect(
    footer.getByRole("link", { name: "Settings", exact: true }),
  ).toBeVisible();
  await footer
    .getByRole("button", { name: "My certifications", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "My certifications" }),
  ).toBeVisible();
  // Administration keeps users, groups and aircraft only.
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  for (const heading of [
    "CSV extract (partial)",
    "FAA API key and renewal",
    "Address verification",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toHaveCount(0);
});

test("program administrators get Flight Program settings but not System", async ({
  page,
}) => {
  await openDemo(page);
  await expectSettings(page);
  await becomeMember(page, PROGRAM_ADMIN);
  await expectSettings(page);
  await expectSections(page, ["My account", "This device", "Flight Program"]);
  for (const heading of [
    "FAA API key and renewal",
    "Address verification",
    "Off-site backups",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toHaveCount(0);
  await expect(
    page.locator("#account").getByText("Flight Program administrator"),
  ).toBeVisible();
  // The Flight Programs edit form, opened from Settings.
  await page
    .getByRole("button", { name: "Edit program details", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit Flight Program" });
  await dialog
    .getByLabel("Flight Program name", { exact: true })
    .fill("Mission operations west");
  await dialog
    .getByRole("button", { name: "Save Flight Program", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#program")).toContainText(
    "Mission operations west",
  );
  const download = page.waitForEvent("download");
  await page
    .locator("#program")
    .getByRole("button", { name: "Download flights.csv", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("demo-program-flights.csv");
  await page.getByRole("link", { name: "Users and access" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
});

test("pilots see only My account and This device", async ({ page }) => {
  await openDemo(page);
  await expectSettings(page);
  await becomeMember(page, PILOT);
  await expectSettings(page);
  await expectSections(page, ["My account", "This device"]);
  for (const heading of ["Default labor rate", "Aircraft Spruce account"])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toHaveCount(0);
  await expect(page.locator("#account")).toContainText("Pilot");
  await expect(
    page.getByRole("link", { name: "Administration", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#nav-group-manage a").last()).toHaveText(
    "Settings",
  );
  await page
    .getByRole("button", { name: "Edit my certifications", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "My certifications" }),
  ).toBeVisible();
});

test("the owner view has no Settings link and keeps its portal", async ({
  page,
}) => {
  await openDemo(page, "/");
  await page
    .getByRole("button", { name: "Preview owner portal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your aircraft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Your aircraft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Exit owner preview", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }).first(),
  ).toBeVisible();
});

test("the theme chosen in Settings persists across reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("angel-one-demo", "true");
    if (!sessionStorage.getItem("theme-seeded")) {
      localStorage.setItem("angelone-theme", "light");
      sessionStorage.setItem("theme-seeded", "true");
    }
  });
  await page.goto("/settings#device");
  await expectSettings(page);
  const theme = page.getByRole("group", { name: "Theme", exact: true });
  await expect(
    theme.getByRole("button", { name: "Light", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await theme.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expectSettings(page);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(
    theme.getByRole("button", { name: "Dark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // The top-bar toggle stays and drives the same setting.
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expect(
    theme.getByRole("button", { name: "Light", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a labor rate saved in Settings shows on Costs", async ({ page }) => {
  await openDemo(page, "/settings#program");
  await expectSettings(page);
  const program = page.locator("#program");
  await program
    .getByLabel("Rate per hour (USD)", { exact: true })
    .fill("95.50");
  await program.getByRole("button", { name: "Save rate", exact: true }).click();
  await expect(
    program.getByText("Current rate $95.50 per hour."),
  ).toBeVisible();
  await page.goto("/costs");
  await expect(
    page.getByRole("heading", { name: "Costs", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Default rate $95.50 per hour.")).toBeVisible();
  await expect(page.getByLabel("Rate per hour (USD)")).toHaveCount(0);
});

test("the alert digest switch uses the My certifications preference and needs a connection", async ({
  page,
  context,
}) => {
  await openDemo(page);
  await expectSettings(page);
  const digest = page.getByRole("switch", {
    name: "Email me a daily alert digest",
  });
  await expect(digest).not.toBeChecked();
  await digest.check();
  await expect(digest).toBeChecked();
  await page.reload();
  await expect(digest).toBeChecked();
  await page
    .getByRole("button", { name: "Edit my certifications", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "My certifications" });
  await expect(
    dialog.getByRole("checkbox", {
      name: "Email me maintenance alerts (daily digest)",
    }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await context.setOffline(true);
  await expect(digest).toBeDisabled();
  await expect(
    page.getByText("Reconnect to change alert email."),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(digest).toBeEnabled();
});

test("moved-panel notices and deep links open the right Settings section", async ({
  page,
}) => {
  await openDemo(page, "/admin");
  await expect(
    page.getByText(
      "Integration keys and data backups are in Settings → System.",
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open System settings" }).click();
  await expect(page).toHaveURL(/\/settings#system$/);
  await expect(
    page.getByRole("heading", { level: 2, name: "System", exact: true }),
  ).toBeInViewport();

  await page.goto("/costs");
  await expect(page.getByText("Labor rate moved to Settings.")).toBeVisible();
  await page
    .getByRole("link", { name: "Open Flight Program settings" })
    .click();
  await expect(page).toHaveURL(/\/settings#program$/);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Flight Program",
      exact: true,
    }),
  ).toBeInViewport();

  await page.goto("/vendors");
  await expect(
    page.getByText("Aircraft Spruce account is in Settings."),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Open Flight Program settings" })
    .click();
  await expect(page).toHaveURL(/\/settings#program$/);
  await expect(
    page.getByRole("heading", { name: "Aircraft Spruce account", exact: true }),
  ).toBeVisible();

  // Deep link straight into a section (a fresh page load, not a hash change
  // on the open page), then jump with the section list.
  await page.goto("/sync");
  await page.goto("/settings#system");
  await expect(
    page.getByRole("heading", { level: 2, name: "System", exact: true }),
  ).toBeInViewport();
  const jump = page.getByRole("navigation", { name: "Settings sections" });
  await expect(
    jump.getByRole("link", { name: "System", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await jump.getByRole("link", { name: "This device", exact: true }).click();
  await expect(page).toHaveURL(/\/settings#device$/);
  await expect(
    jump.getByRole("link", { name: "This device", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(
    page.getByRole("heading", { level: 2, name: "This device", exact: true }),
  ).toBeInViewport();

  // Program administrators reach the same section from their Administration.
  await page.goto("/admin");
  await becomeMember(page, PROGRAM_ADMIN);
  await expect(
    page.getByText(
      "Program details, labor rate and exports are in Settings → Flight Program.",
    ),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Open Flight Program settings" })
    .click();
  await expect(page).toHaveURL(/\/settings#program$/);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Flight Program",
      exact: true,
    }),
  ).toBeInViewport();
});

test("phones reach Settings from the More sheet, not the tab bar", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openDemo(page, "/");
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
      name: "Settings",
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page
    .getByRole("dialog", { name: "All sections" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expectSettings(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);
  const box = await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "System", exact: true })
    .boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
});

interface MemberGroup {
  id: string;
  name: string;
  permissions: string[];
  programAdmin?: boolean;
}

async function openDemo(page: Page, path = "/settings") {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
}

async function expectSettings(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
  ).toBeVisible();
}

/** Asserts the section list and level-2 headings show exactly `visible`. */
async function expectSections(page: Page, visible: string[]) {
  const jump = page.getByRole("navigation", { name: "Settings sections" });
  await expect(jump.getByRole("link")).toHaveText(visible);
  for (const name of SECTIONS)
    await expect(
      page.getByRole("heading", { level: 2, name, exact: true }),
    ).toHaveCount(visible.includes(name) ? 1 : 0);
}

/**
 * Replaces the demo user's access with one permission group in the demo
 * program, in every stored snapshot, then reloads.
 */
async function becomeMember(page: Page, group: MemberGroup) {
  // Edit the stored snapshot only once the app has started, or its own
  // startup save can land after this edit and undo it.
  await expect(page.getByRole("main")).toBeVisible();
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
