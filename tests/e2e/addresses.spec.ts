/**
 * Responsibility: Pins a location address's separate contact fields, its
 *   confirmation, and its reuse as a purchase order's shipping address.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect } from "@playwright/test";

test("location addresses retain separate contact fields and autofill PO shipping", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New location", exact: true }).click();
  let dialog = page.getByRole("dialog").last();
  await dialog
    .getByLabel("Location name", { exact: true })
    .fill("Verified receiving location");
  const values: Record<string, string> = {
    "Street address": "1600 Pennsylvania Avenue NW",
    "Apartment / suite / building": "Receiving desk",
    City: "Washington",
    "State / province": "DC",
    "ZIP / postal code": "bad",
    Country: "United States",
    "Contact name": "Receiving",
    Email: "receiving@example.com",
    Phone: "+1 202 555 0100",
  };
  for (const [label, value] of Object.entries(values))
    await dialog
      .getByLabel(`Location address — ${label}`, { exact: true })
      .fill(value);
  await dialog
    .getByRole("button", { name: "Check & confirm address", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "US ZIP code must be 5 digits or ZIP+4.",
  );
  await dialog.getByLabel("Location address — ZIP / postal code").fill("20500");
  await dialog
    .getByRole("button", { name: "Check & confirm address", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Confirmed by you");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Verified receiving location", { exact: true }),
  ).toBeVisible();
  await page.goto("/purchase-orders");
  await page.getByRole("button", { name: "New PO", exact: true }).click();
  dialog = page.getByRole("dialog").last();
  await dialog
    .getByLabel("Part 1 inventory location")
    .selectOption({ label: "Verified receiving location" });
  await expect(
    dialog.getByLabel("Shipping address — Street address"),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Shipping address — Use inventory location address?")
    .selectOption("inventory");
  await dialog
    .getByRole("button", { name: "Review selected address", exact: true })
    .click();
  const poForm = dialog;
  dialog = page.getByRole("dialog", {
    name: "Add new shipping address",
    exact: true,
  });
  for (const [label, value] of Object.entries({
    ...values,
    "ZIP / postal code": "20500",
  }))
    await expect(
      dialog.getByLabel(`Shipping address — ${label}`, { exact: true }),
    ).toHaveValue(value);
  const shipping = dialog
    .locator("fieldset.address-fields")
    .filter({ has: page.getByText("Shipping address", { exact: true }) });
  await expect(shipping.getByRole("status")).toContainText("Confirmed by you");
  await dialog.getByLabel("Shipping address — Phone").fill("+1 202 555 0199");
  await expect(shipping.getByRole("status")).toContainText(
    "Review the full address",
  );
  await shipping
    .getByRole("button", { name: "Look up address", exact: true })
    .click();
  await expect(
    shipping.getByText(
      "External address lookups are available in the connected app, not demo mode.",
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel("Shipping address — Phone")).toHaveValue(
    "+1 202 555 0199",
  );
  await dialog
    .getByRole("button", { name: "Save address", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    poForm
      .getByLabel("Shipping address — Saved address")
      .locator("option:checked"),
  ).toContainText("Verified receiving location");
  await page.goto("/saved-addresses");
  await expect(
    page.getByRole("row").filter({ hasText: "Verified receiving location" }),
  ).toContainText("Receiving");
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: "Verified receiving location" }),
  ).toBeVisible();
  // The Geoapify key moved from Administration to Settings → System.
  await page.goto("/settings#system");
  await expect(
    page.getByRole("heading", { name: "Address verification", exact: true }),
  ).toBeVisible();
  // The key is entered in the Update… dialog, which the demo cannot open.
  await expect(
    page.getByRole("button", { name: "Update Geoapify API key" }),
  ).toBeDisabled();
});
