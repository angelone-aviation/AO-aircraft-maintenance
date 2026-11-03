import { z } from "zod";
const field = z.string().trim().max(300);
export const addressSchema = z
  .object({
    addressName: field.optional(),
    organization: field.default(""),
    street: z.string().trim().max(2000).default(""),
    street2: field.default(""),
    city: field.default(""),
    region: field.default(""),
    postalCode: field.default(""),
    country: field.default(""),
    contactName: field.default(""),
    email: z.union([z.literal(""), z.email()]).default(""),
    phone: field
      .refine(
        (value) =>
          !value ||
          (value.replace(/\D/g, "").length >= 7 &&
            /^[+\d\s().\-xext]+$/i.test(value)),
        "Enter a valid phone number, including area/country code.",
      )
      .default(""),
    confirmed: z.boolean().default(false),
  })
  .refine(
    (a) =>
      Object.values(a)
        .filter((value) => typeof value === "string")
        .join("\n").length <= 1900,
    "Address and contact details are too long.",
  );
export type Address = z.infer<typeof addressSchema>;
export function blankAddress(
  legacy = "",
  contactName = "",
  email = "",
): Address {
  return {
    organization: "",
    street: legacy,
    street2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    contactName,
    email,
    phone: "",
    confirmed: false,
  };
}
export function formatAddress(a: Address): string {
  return [
    a.organization,
    a.street,
    a.street2,
    [a.city, a.region, a.postalCode].filter(Boolean).join(", "),
    a.country,
    a.contactName && `Contact: ${a.contactName}`,
    a.email && `Email: ${a.email}`,
    a.phone && `Phone: ${a.phone}`,
  ]
    .filter(Boolean)
    .join("\n");
}
export function addressIssues(a: Address): string[] {
  const errors: string[] = [];
  for (const [key, label] of [
    ["street", "Street address"],
    ["city", "City"],
    ["country", "Country"],
    ["contactName", "Contact name"],
    ["email", "Email"],
    ["phone", "Phone"],
  ] as const) {
    if (!a[key].trim()) errors.push(`${label} is required.`);
  }
  const country = a.country.trim().toUpperCase();
  const us = [
    "US",
    "USA",
    "UNITED STATES",
    "UNITED STATES OF AMERICA",
  ].includes(country);
  const ca = ["CA", "CANADA"].includes(country);
  if (
    (us || ca || ["AU", "AUSTRALIA", "PH", "PHILIPPINES"].includes(country)) &&
    !a.region.trim()
  )
    errors.push("State / province is required.");
  if (
    !["HONG KONG", "HK", "MACAU", "MO"].includes(country) &&
    !a.postalCode.trim()
  )
    errors.push(
      "ZIP / postal code is required (enter N/A where no postal code is used).",
    );
  if (us && !/^\d{5}(-\d{4})?$/.test(a.postalCode))
    errors.push("US ZIP code must be 5 digits or ZIP+4.");
  if (ca && !/^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(a.postalCode))
    errors.push("Canadian postal code must use the format A1A 1A1.");
  const parsed = addressSchema.safeParse(a);
  if (!parsed.success)
    errors.push(...parsed.error.issues.map((i) => i.message));
  return [...new Set(errors)];
}
export function assertConfirmedAddress(a: Address) {
  const issues = addressIssues(a);
  if (issues.length) throw Error(`Shipping address: ${issues.join(" ")}`);
  if (!a.confirmed)
    throw Error(
      "Review and confirm the shipping address before issuing this PO.",
    );
}
export function addressFromForm(data: FormData, name = "addressDetails") {
  const value = data.get(name);
  return value ? addressSchema.parse(JSON.parse(String(value))) : undefined;
}
