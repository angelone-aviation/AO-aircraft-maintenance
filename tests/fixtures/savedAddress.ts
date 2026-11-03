import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
export async function addSavedAddress(
  page: Page,
  form: Locator,
  label: string,
  name: string,
  street: string,
) {
  await form
    .getByLabel(`${label} — Saved address`, { exact: true })
    .selectOption("__new");
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
