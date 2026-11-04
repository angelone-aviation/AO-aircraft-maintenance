/**
 * Responsibility: Adds a saved shipping address through an address picker.
 * Layer: Test. Playwright helper against the demo.
 * Dependencies: @playwright/test.
 */
import { expect, type Locator, type Page } from "@playwright/test";

// The picker option that opens the Add new shipping address dialog.
const NEW_ADDRESS_OPTION = "__new";

/**
 * Adds `name` at `street` (Washington, DC) through the `label` picker in
 * `form`, then checks the picker selects it.
 * @param page - The page the address dialog opens on.
 * @param form - The form holding the picker.
 * @param label - The picker's label prefix, as in "<label> — Saved address".
 * @param name - The saved address's name.
 * @param street - Its street address.
 */
export async function addSavedAddress(
  page: Page,
  form: Locator,
  label: string,
  name: string,
  street: string,
) {
  await form
    .getByLabel(`${label} — Saved address`, { exact: true })
    .selectOption(NEW_ADDRESS_OPTION);
  const address = page.getByRole("dialog", {
    name: "Add new shipping address",
    exact: true,
  });
  await address.getByLabel("Address name", { exact: true }).fill(name);
  for (const [field, value] of Object.entries({
    "Street address": street,
    City: "Washington",
    "State / province": "DC",
    "ZIP / postal code": "20500",
    Country: "United States",
    "Contact name": "Receiving",
    Email: "receiving@example.com",
    Phone: "+1 202 555 0100",
  }))
    await address
      .getByLabel(`Shipping address — ${field}`, { exact: true })
      .fill(value);
  await address
    .getByRole("button", { name: "Save address", exact: true })
    .click();
  await expect(address).not.toBeVisible();
  await expect(
    form.getByLabel(`${label} — Saved address`).locator("option:checked"),
  ).toContainText(name);
}
