import { test, expect } from "@playwright/test";
test("PO vendor quick add, full details and directory edits preserve the order", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/purchase-orders");
  await page.getByRole("button", { name: "New PO", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByLabel("Vendor", { exact: true }).fill("Quick supplier");
  await dialog.getByRole("button", { name: "Quick add", exact: true }).click();
  await expect(
    dialog.getByText("Vendor not found.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    dialog.getByLabel("Vendor address — Street address"),
  ).toHaveCount(0);
  await dialog.getByLabel("Part 1 number", { exact: true }).fill("KEEP-PART");
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
  await expect(dialog.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Detailed supplier",
  );
  await expect(dialog.getByLabel("Part 1 number", { exact: true })).toHaveValue(
    "KEEP-PART",
  );
  await dialog.getByLabel("Vendor", { exact: true }).fill("quick supplier");
  await dialog.getByLabel("Part 1 number", { exact: true }).focus();
  await expect(dialog.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Quick supplier",
  );
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByRole("link", { name: "View vendors", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Detailed supplier" })
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
  await expect(
    page.getByRole("row").filter({ hasText: "Detailed supplier" }),
  ).toContainText("+1 202 555 0111");
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: "Quick supplier" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Detailed supplier" }),
  ).toContainText("orders@example.com");
});
