/**
 * Responsibility: Pins the core maintenance screens: a recurring inspection
 *   completed with history kept, component install, removal and overhaul,
 *   stock balances and over-issue, component baselines and service
 *   requirements, and inspection tracking choices.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, src/domain/model (localDate),
 *   tests/fixtures/workOrderTasks.
 */
import { test, expect, type Page } from "@playwright/test";
import { localDate } from "../../src/domain/model";
import { openMovementOrder } from "../fixtures/workOrderTasks";

const DAY_MS = 86400000;
// Service age counts average months (365.25 / 12 days), not calendar months.
const AVERAGE_MONTH_DAYS = 30.4375;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
});

test("creates a recurring inspection, completes it, and preserves history", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Inspections", exact: true }).click();
  await page.getByRole("button", { name: "New inspection" }).click();
  await page.getByLabel("ATA Chapter", { exact: true }).selectOption("05");
  await page.getByLabel("Reference", { exact: true }).fill("TEST-100");
  await page.getByLabel("Description", { exact: true }).fill("Workshop check");
  await page.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await page.getByLabel("Repeat every (hours)", { exact: true }).fill("100");
  await page.getByLabel("Last complied at (tracked hours)").fill("2300");
  await page.getByRole("checkbox", { name: "Calendar", exact: true }).check();
  await page.getByLabel("Repeat every (months)", { exact: true }).fill("12");
  await page.getByLabel("Last compliance date").fill("2025-01-15");
  await expect(page.getByLabel("Required parts and supplies")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "TEST-100" });
  await expect(row).toContainText("2,400.0");
  await row.getByRole("button", { name: "Complete", exact: true }).click();
  await page.getByLabel("Completion date").fill("2026-01-15");
  await page
    .getByLabel("Work performed / reason")
    .fill("Inspection completed and signed");
  await page
    .getByRole("button", { name: "Record completion", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // Due 100 hours after the aircraft's 2,341.2, and 12 calendar months after
  // completion, to the end of that month (14 CFR 91.409).
  await expect(row).toContainText("2,441.2");
  await expect(row).toContainText("2027-01-31");
  await page.reload();
  await row.getByRole("button", { name: "Details" }).click();
  await expect(page.getByLabel("ATA Chapter", { exact: true })).toHaveValue(
    "05",
  );
  // The list no longer shows the ATA chapter; check its label in Details.
  await expect(
    page.getByLabel("ATA Chapter", { exact: true }).locator("option:checked"),
  ).toHaveText("ATA 05: Time Limits / Maintenance Checks");
  await expect(
    page.getByText("Inspection completed and signed", { exact: true }),
  ).toBeVisible();
});

test("creates a component, installs, removes, and records overhaul", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Components", exact: true }).click();
  await page.getByRole("button", { name: "New component" }).click();
  await page
    .getByLabel("Component type", { exact: true })
    .selectOption("Engine");
  await page
    .getByLabel("Manufacturer", { exact: true })
    .fill("Example Engines");
  await page.getByLabel("Parts location", { exact: true }).fill("Shelf A");
  await page.getByLabel("Part number", { exact: true }).fill("ENG-100");
  await page.getByLabel("Serial number").fill("SERIAL-1");
  await page.getByLabel("ATA Chapter", { exact: true }).selectOption("72");
  await page
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("250");
  await page
    .getByLabel("Time Since Overhaul (TSO) at install (hours)", { exact: true })
    .fill("50");
  await page
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "ENG-100" });
  await expect(row).toContainText("In storage");
  for (const operation of ["install", "remove", "overhaul"]) {
    await row
      .getByRole("button", { name: "Add Service/Inspections", exact: true })
      .click();
    if (operation === "remove")
      await page.getByLabel("Shelf / bin", { exact: true }).fill("Shelf B");
    if (operation === "overhaul") await recordOverhaul(page);
    else await moveComponent(page, "Workshop " + operation, "ENG-100");
    await expect(row).toContainText(
      operation === "install" ? "Installed" : "In storage",
    );
  }
  // An overhaul resets time since overhaul but not time since new.
  await expect(row).toContainText("250.0 h");
  await expect(row).toContainText("0.0 h");
  await expect(row).toContainText("ATA 72: Engine – Turbine / Reciprocating");
  await row.getByRole("button", { name: "Details" }).click();
  await page
    .getByRole("button", { name: "Edit component", exact: true })
    .click();
  await expect(page.getByLabel("ATA Chapter", { exact: true })).toHaveValue(
    "72",
  );
  await page.getByLabel("ATA Chapter", { exact: true }).selectOption("00");
  await page
    .getByRole("button", { name: "Save component details", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: "ENG-100" }),
  ).toContainText("ATA 00: General");
});

test("manages stock balances, rejects over-issue, and disables offline writes", async ({
  page,
  context,
}) => {
  await page.getByRole("link", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "New location" }).click();
  await page.getByLabel("Location name").fill("Main hangar");
  await page
    .getByLabel("Location address — Street address", { exact: true })
    .fill("Workshop");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "New stock item" }).click();
  await page.getByLabel("Part number", { exact: true }).fill("FILTER-1");
  await page.getByLabel("Description", { exact: true }).fill("Oil filter");
  await page.getByLabel("Reorder at or below").fill("2");
  await page.getByLabel("Qty", { exact: true }).fill("7");
  await page.getByLabel("Vendor", { exact: true }).fill("Aircraft Supply Co");
  await page.getByLabel("Invoice #", { exact: true }).fill("INV-100");
  await page.getByLabel("PO Ref", { exact: true }).fill("PO-200");
  await page.getByLabel("Cost", { exact: true }).fill("123.45");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
  await page.reload();
  await expect(row).toContainText("Aircraft Supply Co");
  await expect(row).toContainText("INV-100");
  await expect(row).toContainText("PO-200");
  await expect(row).toContainText("123.45");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByLabel("Cost", { exact: true })).toHaveValue("123.45");
  await expect(page.getByLabel("Qty", { exact: true })).toHaveValue("7");
  await page.getByLabel("Qty", { exact: true }).fill("0");
  await page.getByLabel("Invoice #", { exact: true }).fill("");
  await page.getByLabel("Cost", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row).not.toContainText("INV-100");
  await expect(row).toContainText("0.00");
  await expect(row.getByRole("cell").nth(3).locator("strong")).toHaveText("0");
  await row.getByRole("button", { name: "Move stock" }).click();
  await page.getByLabel("Quantity (counted balance for adjustment)").fill("5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row).toContainText("In stock");
  await row.getByRole("button", { name: "Move stock" }).click();
  await page.getByLabel("Movement type").selectOption("issue");
  await page.getByLabel("Quantity (counted balance for adjustment)").fill("6");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Insufficient stock");
  await page.getByLabel("Quantity (counted balance for adjustment)").fill("4");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // One left is at or below the reorder point of 2.
  await expect(row).toContainText("Reorder");
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "New stock item" }),
  ).toBeDisabled();
  await expect(row.getByRole("button", { name: "Move stock" })).toBeDisabled();
});

test("records legacy component fields, verified baselines, and separate service requirements", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Components", exact: true }).click();
  await page.getByRole("button", { name: "New component" }).click();
  // Component type is now a fixed category; the name identifies the part.
  await page
    .getByLabel("Component type", { exact: true })
    .selectOption("Appliance");
  await page
    .getByLabel("Component Name", { exact: true })
    .fill("Hydraulic pump");
  await page.getByLabel("Part number", { exact: true }).fill("PUMP-500");
  await page.getByLabel("Serial number", { exact: true }).fill("SER-50");
  await page
    .getByLabel("Manufacturer", { exact: true })
    .fill("Workshop Manufacturing");
  await page.getByLabel("ATA Chapter", { exact: true }).selectOption("29");
  await page.getByLabel("Parts location", { exact: true }).fill("Legacy store");
  const installed = new Date(Date.now() - 10 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  await page
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("100");
  await page
    .getByLabel("Time Since Overhaul (TSO) at install (hours)", { exact: true })
    .fill("20");
  await page
    .getByLabel("Time Since Repair (TSR) at install (hours)", { exact: true })
    .fill("10");
  await page
    .getByLabel("Component cycles at install", { exact: true })
    .fill("50");
  await page
    .getByLabel("Calendar time since new (months)", { exact: true })
    .fill("0.657");
  await page
    .getByLabel("Notes", { exact: true })
    .fill("Source: component card");
  await page
    .getByRole("button", { name: "Save component", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "PUMP-500" });
  await row
    .getByRole("button", { name: "Add Service/Inspections", exact: true })
    .click();
  await page
    .getByLabel("Installation position", { exact: true })
    .selectOption("LEFT");
  await moveComponent(page, "Install hydraulic pump", "PUMP-500");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Set baseline", exact: true }).click();
  await page.getByLabel("Installation date", { exact: true }).fill(installed);
  await page
    .getByLabel("Aircraft total time at install (hours)", { exact: true })
    .fill("2331.2");
  await page
    .getByRole("button", { name: "Save verified baseline", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await expect(row).toContainText("Workshop Manufacturing");
  // 100 TSN at install plus the 10 hours flown since 2,331.2.
  await expect(row).toContainText("110.0 h");
  // Columns are now grouped: readings (2) and nearest service remaining (3).
  // 0.657 months at install plus ten days in service (0.33 months).
  await expect(row.getByRole("cell").nth(2)).toContainText(
    "Calendar time since new: 1.0 months",
  );
  await row.getByRole("button", { name: "Details", exact: true }).click();
  // This details action now carries the "Add service requirement" label.
  await page
    .getByRole("button", { name: "Add service requirement", exact: true })
    .click();
  await page
    .getByLabel("Requirement type")
    .selectOption("Inspection Requirement");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Repair follow-up");
  await page.getByLabel("Time basis", { exact: true }).selectOption("TSR");
  await page
    .getByLabel("Hour limit basis", { exact: true })
    .selectOption("FROM_LAST_COMPLIED");
  await page.getByLabel("Hour limit / interval", { exact: true }).fill("50");
  await page
    .getByLabel("Last complied component hours", { exact: true })
    .fill("5");
  await page
    .getByLabel("Last complied date", { exact: true })
    .fill("2026-01-15");
  await page.getByLabel("Calendar interval", { exact: true }).fill("1");
  await page.getByLabel("Cycle limit / interval", { exact: true }).fill("500");
  await page
    .getByRole("button", { name: "Calculate and save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await row.getByRole("button", { name: "Details", exact: true }).click();
  const requirement = page
    .getByRole("row")
    .filter({ hasText: "Repair follow-up" });
  // Due at 5 + 50 TSR, and one calendar month after 2026-01-15, to the end of
  // that month; cycles count from the 50 at install toward the 500 limit.
  await expect(requirement).toContainText("55.0 TSR");
  await expect(requirement).toContainText("2026-02-28");
  const remainingDays = Math.round(
    (Date.parse("2026-02-28") - Date.parse(localDate())) / DAY_MS,
  );
  await expect(row.getByRole("cell").nth(3)).toContainText(
    `≈ ${(remainingDays / AVERAGE_MONTH_DAYS).toFixed(1)} months`,
  );

  await expect(
    row.getByRole("cell").nth(3).locator("div").filter({ hasText: "cycles" }),
  ).toHaveText("450 cycles");
  await expect(requirement).toContainText("450 cycles");

  await page.getByRole("button", { name: "Set baseline", exact: true }).click();
  await page
    .getByLabel("Time Since New (TSN) at install (hours)", { exact: true })
    .fill("200");
  await page
    .getByRole("button", { name: "Save verified baseline", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(row).toContainText("210.0 h");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Movement and baseline history",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Component baseline updated.", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "BASELINE" }).last(),
  ).toContainText("Component baseline updated.");
});

test("inspection tracking toggles and saves before opening linked requests", async ({
  page,
}) => {
  await page.goto("/inspections");
  await page
    .getByRole("button", { name: "New inspection", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "New inspection",
    exact: true,
  });
  await form
    .getByLabel("Description", { exact: true })
    .fill("Landing inspection request test");
  await form.getByLabel("Reference", { exact: true }).fill("LANDING-REQUEST");
  for (const name of ["Hours", "Calendar", "Cycles", "Landings"])
    await expect(
      form.getByRole("checkbox", { name, exact: true }),
    ).toBeVisible();
  await form.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await form.getByLabel("Repeat every (hours)", { exact: true }).fill("25");
  await form.getByRole("checkbox", { name: "Hours", exact: true }).uncheck();
  await expect(
    form.getByLabel("Repeat every (hours)", { exact: true }),
  ).toBeHidden();
  await form.getByRole("checkbox", { name: "Landings", exact: true }).check();
  await form.getByLabel("Repeat every (landings)", { exact: true }).fill("100");
  await form
    .getByLabel("Last complied at (aircraft total landings)", { exact: true })
    .fill("200");
  // Opening linked requests saves the new inspection first.
  await form
    .getByRole("button", { name: "Add parts / repair request", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  const requests = page.getByRole("dialog", {
    name: "Add parts / repair request",
    exact: true,
  });
  await expect(
    requests.getByRole("button", { name: "New request", exact: true }),
  ).toBeVisible();
  await requests
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: "LANDING-REQUEST" });
  await expect(row).toContainText("300 landings");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "Inspection details",
    exact: true,
  });
  await expect(
    details.getByRole("checkbox", { name: "Hours", exact: true }),
  ).not.toBeChecked();
  await expect(
    details.getByRole("checkbox", { name: "Landings", exact: true }),
  ).toBeChecked();
  await expect(details.getByLabel("Required parts and supplies")).toHaveCount(
    0,
  );
  await expect(
    details.getByRole("button", {
      name: "Add parts / repair request",
      exact: true,
    }),
  ).toBeVisible();
});

/** Records a workshop overhaul as a service event on the open component. */
async function recordOverhaul(page: Page) {
  await page.getByLabel("Service action").selectOption("overhaul");
  await page.getByLabel("Work performed / reason").fill("Workshop overhaul");
  await page
    .getByRole("button", { name: "Save service event", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

/**
 * Adds the open install or removal to a work order, completes that order,
 * and returns to Components: a component only moves when its order closes.
 */
async function moveComponent(page: Page, reason: string, part: string) {
  await page.getByLabel("Movement description / reason").fill(reason);
  await page
    .getByRole("button", { name: "Add movement to work order", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const order = await openMovementOrder(page, part);
  await order.getByLabel("Task 1 status").selectOption("completed");
  await order
    .getByLabel("Task 1 work notes")
    .fill("Component movement performed and verified");
  await order.getByLabel("Work order status").selectOption("completed");
  await order.getByLabel("Completion date").fill(localDate());
  await order.getByLabel("Release outcome").fill("Reviewed movement");
  page.once("dialog", (confirmation) => confirmation.accept());
  await order
    .getByRole("button", { name: "Save work order", exact: true })
    .click();
  await expect(order).not.toBeVisible();
  await page.goto("/components");
}
