/**
 * Responsibility: Pins component templates: a CSV template applied to an
 *   aircraft as incomplete setups, a child row waiting for its parent, and
 *   completing an entry into the aircraft's components.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";
test("imports recommended components as incomplete setups and completes a verified entry", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/components");
  await page
    .getByRole("link", { name: "Imported components", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Component templates", exact: true })
    .click();
  await page
    .getByRole("button", { name: "New template / import CSV", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "New component template",
    exact: true,
  });
  await editor
    .getByLabel("Template name", { exact: true })
    .fill("206 Equipment");
  await editor
    .getByLabel("Aircraft manufacturer / make", { exact: true })
    .fill("Cessna");
  await editor
    .getByLabel("Aircraft model", { exact: true })
    .fill("206 Stationair");
  await editor
    .getByLabel("Component rows (CSV)", { exact: true })
    .fill(
      "Component type,ATA chapter,Part number,Component Name,Manufacturer,Position,ID,Parent ID\nEngine,72,E123,Template engine,Maker,MAIN,engine,\nAppliance,72,A123,Attached part,Maker,,child,engine",
    );
  await editor
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await page
    .getByRole("button", { name: "Preview / apply to aircraft", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Preview component import",
    exact: true,
  });
  await preview
    .getByLabel("Target aircraft", { exact: true })
    .selectOption("demo-206");
  await preview
    .getByRole("button", { name: "Select new entries", exact: true })
    .click();
  await preview
    .getByRole("button", {
      name: "Import selected as setup incomplete",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Setup incomplete — 2 recommended components", {
      exact: true,
    }),
  ).toBeVisible();
  // "Attached part" names the engine as its parent, so it waits for the
  // engine's setup.
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Attached part" })
      .getByRole("button", { name: "Complete setup" }),
  ).toBeDisabled();
  await page
    .getByRole("row")
    .filter({ hasText: "Template engine" })
    .getByRole("button", { name: "Complete setup" })
    .first()
    .click();
  const form = page.getByRole("dialog", {
    name: "Complete setup — Template engine",
    exact: true,
  });
  await expect(form.getByLabel("Serial number", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    form.getByLabel("Installation date", { exact: true }),
  ).toHaveValue("");
  await expect(
    form.getByLabel("Time Since New (TSN) at install (hours)", { exact: true }),
  ).toHaveValue("");
  await form
    .getByLabel("Installation date", { exact: true })
    .fill("2025-01-01");
  await form
    .getByLabel("Aircraft total time at install (hours)", { exact: true })
    .fill("2000");
  await form
    .getByLabel("Aircraft cycles at install", { exact: true })
    .fill("1000");
  await form
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("100");
  await form
    .getByLabel("Component cycles at install", { exact: true })
    .fill("50");
  await form
    .getByLabel("Calendar time since new (months)", { exact: true })
    .fill("0");
  await form
    .getByRole("checkbox", { name: /This component is already installed/ })
    .check();
  await form
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await expect(
    page.getByText("Setup incomplete — 1 recommended components", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Attached part" })
      .getByRole("button", { name: "Complete setup" }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByText("Setup incomplete — 1 recommended components", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Back to components", exact: true })
    .click();
  const group = page
    .locator("details.component-group")
    .filter({ has: page.locator("summary", { hasText: "N206MA" }) });
  const record = group.getByRole("row").filter({ hasText: "Template engine" });
  await expect(record).toBeVisible();
  await expect(
    record.getByRole("button", {
      name: "Add Service/Inspections",
      exact: true,
    }),
  ).toBeVisible();
  await group.locator("summary").click();
  await expect(record).not.toBeVisible();
  await group.locator("summary").click();
  await expect(record).toBeVisible();
});
