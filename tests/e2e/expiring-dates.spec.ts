/**
 * Responsibility: Pins expiring dates end to end in the demo: adding one for
 *   the Flight Program and one system-wide, their alerts under the bell,
 *   archiving, and that the demo offers no device alerts.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const DAY_MS = 86_400_000;
const isoDate = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

async function openSettings(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
}

async function addDate(
  page: Page,
  section: "#program" | "#system",
  fields: { label: string; kind: string; expiresOn: string },
) {
  const add =
    section === "#program"
      ? "Add program expiring date"
      : "Add deployment expiring date";
  await page
    .locator(section)
    .getByRole("button", { name: add, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add expiring date" });
  await dialog.getByLabel("What expires").fill(fields.label);
  await dialog.getByLabel("Kind").selectOption(fields.kind);
  await dialog.getByLabel("Expires on").fill(fields.expiresOn);
  await dialog
    .getByRole("button", { name: "Save expiring date", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}

test("expiring dates are recorded per Flight Program and system-wide, alert under the bell, and archive", async ({
  page,
}) => {
  await openSettings(page);
  const program = page.locator("#program");
  const system = page.locator("#system");
  await expect(
    program.getByRole("heading", { level: 3, name: "Program expiring dates" }),
  ).toBeVisible();
  await expect(program.getByText("No expiring dates recorded.")).toBeVisible();

  await addDate(page, "#program", {
    label: "Hull policy",
    kind: "insurance",
    expiresOn: isoDate(10),
  });
  await expect(program.getByText("Hull policy", { exact: true })).toBeVisible();
  await expect(program.getByText("10 days left")).toBeVisible();

  await addDate(page, "#system", {
    label: "Entra client secret",
    kind: "secret",
    expiresOn: isoDate(-1),
  });
  await expect(system.getByText("Entra client secret")).toBeVisible();
  await expect(system.getByText("Expired", { exact: true })).toBeVisible();
  // A program row never shows under System, nor the other way round.
  await expect(system.getByText("Hull policy", { exact: true })).toHaveCount(0);
  await expect(program.getByText("Entra client secret")).toHaveCount(0);

  await page.goto("/alerts");
  const comingDue = page.getByRole("region", { name: "Coming due" });
  await expect(
    comingDue.getByText(`Hull policy expires on ${isoDate(10)}`),
  ).toBeVisible();
  const actionRequired = page.getByRole("region", { name: "Action required" });
  await expect(
    actionRequired.getByText(`Entra client secret expired on ${isoDate(-1)}`),
  ).toBeVisible();
  await actionRequired
    .getByRole("link", { name: "Open", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/settings$/);

  // Archiving removes the row and its alert; the record itself is kept.
  await page
    .locator("#system")
    .getByRole("button", { name: "Edit Entra client secret" })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Archive Entra client secret" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator("#system").getByText("Entra client secret"),
  ).toHaveCount(0);
  await page.goto("/alerts");
  await expect(page.getByText("Entra client secret expired")).toHaveCount(0);
  await expect(
    page.getByText(`Hull policy expires on ${isoDate(10)}`),
  ).toBeVisible();
});

test("the demo offers no device alerts, since no push service can reach it", async ({
  page,
}) => {
  await openSettings(page);
  await expect(page.getByText("Alert this device")).toHaveCount(0);
  await expect(
    page.getByText("Not available in the demo: no alerts leave this browser."),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Email me urgent alerts at once" }),
  ).toBeVisible();
});
