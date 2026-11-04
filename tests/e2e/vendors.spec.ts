/**
 * Responsibility: Pins vendors from a purchase order: quick add without an
 *   address, full details without losing the order's lines, matching a typed
 *   name to a saved vendor, and edits in the vendor directory.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

test("PO vendor quick add, full details and directory edits preserve the order", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/purchase-orders");
  await page.getByRole("button", { name: "New PO", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  const vendor = dialog.getByLabel("Vendor", { exact: true });
  const partNumber = dialog.getByLabel("Part 1 number", { exact: true });
  await vendor.fill("Quick supplier");
  await dialog.getByRole("button", { name: "Quick add", exact: true }).click();
  await expect(
    dialog.getByText("Vendor not found.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    dialog.getByLabel("Vendor address — Street address"),
  ).toHaveCount(0);
  await partNumber.fill("KEEP-PART");
  await addDetailedVendor(dialog);
  await expect(vendor).toHaveValue("Detailed supplier");
  await expect(partNumber).toHaveValue("KEEP-PART");
  // Leaving the field matches a typed name to the saved vendor, ignoring case.
  await vendor.fill("quick supplier");
  await partNumber.focus();
  await expect(vendor).toHaveValue("Quick supplier");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByRole("link", { name: "View vendors", exact: true }).click();
  await editDetailedVendorPhone(page);
  await expect(vendorRow(page, "Detailed supplier")).toContainText(
    "+1 202 555 0111",
  );
  await page.reload();
  await expect(vendorRow(page, "Quick supplier")).toBeVisible();
  await expect(vendorRow(page, "Detailed supplier")).toContainText(
    "orders@example.com",
  );
});

/** Adds "Detailed supplier" with an email and account number from the PO. */
async function addDetailedVendor(dialog: Locator) {
  await dialog.getByLabel("Vendor", { exact: true }).fill("Detailed supplier");
  await dialog.getByRole("button", { name: "Add vendor", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Add vendor", exact: true }),
  ).toBeVisible();
  await dialog
    .getByLabel("Vendor address — Email", { exact: true })
    .fill("orders@example.com");
  await dialog.getByLabel("Account number", { exact: true }).fill("ACCT-123");
  await dialog
    .getByRole("button", { name: "Save vendor", exact: true })
    .click();
}

/** Checks the directory editor kept the PO's details, then saves a phone. */
async function editDetailedVendorPhone(page: Page) {
  await vendorRow(page, "Detailed supplier")
    .getByRole("button", { name: "Edit vendor" })
    .click();
  await expect(page.getByLabel("Account number", { exact: true })).toHaveValue(
    "ACCT-123",
  );
  await expect(
    page.getByLabel("Vendor address — Email", { exact: true }),
  ).toHaveValue("orders@example.com");
  await page
    .getByLabel("Vendor address — Phone", { exact: true })
    .fill("+1 202 555 0111");
  await page.getByRole("button", { name: "Save vendor", exact: true }).click();
}

function vendorRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ hasText: name });
}
