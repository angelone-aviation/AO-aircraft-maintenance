/**
 * Responsibility: Structured postal address with its receiving contact, and the
 *   checks that decide whether it is complete enough to ship to.
 * Layer: Domain. Pure zod schema and functions; no I/O, no React.
 * Dependencies: zod, src/domain/rejection.ts (the refusal class).
 *
 * Format and completeness checks only, not postal verification: a person must
 * still confirm a shipping address before a purchase order is issued.
 */
import { z } from "zod";
import { Rejection } from "./rejection";

/** The most characters an address field other than the street may store. */
export const ADDRESS_FIELD_MAX_LENGTH = 300;

/**
 * The most characters the street line may store. Longer than other fields:
 * blankAddress() puts a whole legacy address here. COMBINED_MAX_LENGTH caps
 * it near 1,890 in practice.
 */
export const ADDRESS_STREET_MAX_LENGTH = 2000;

// formatAddress() output is stored in 2,000-character fields (PO shipTo,
// vendorContact); this leaves room for its labels.
const COMBINED_MAX_LENGTH = 1900;

// Plausibility floor (a 7-digit local number); it does not prove an area code.
// Stored addresses parse with this rule, so raising it would make records
// unreadable; the refusal asks for no more than it checks.
const PHONE_MIN_DIGITS = 7;

// Loose whitelist: "x", "e" and "t" may appear anywhere, so "ext" passes.
const PHONE_CHARACTERS = /^[+\d\s().\-xext]+$/i;

const US_ZIP_CODE = /^\d{5}(-\d{4})?$/;
const CANADIAN_POSTAL_CODE = /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i;

// Country is free text, so each rule matches the ISO 3166 codes and English
// names people type, after trimming and upper-casing.
const US_COUNTRY_NAMES: readonly string[] = [
  "US",
  "USA",
  "UNITED STATES",
  "UNITED STATES OF AMERICA",
];
const CANADA_COUNTRY_NAMES: readonly string[] = ["CA", "CANADA"];
const REGION_REQUIRED_COUNTRY_NAMES: readonly string[] = [
  ...US_COUNTRY_NAMES,
  ...CANADA_COUNTRY_NAMES,
  "AU",
  "AUSTRALIA",
  "PH",
  "PHILIPPINES",
];
const NO_POSTAL_CODE_COUNTRY_NAMES: readonly string[] = [
  "HONG KONG",
  "HK",
  "MACAU",
  "MO",
];

// In form order, which is the order the issues are listed in.
const REQUIRED_FIELDS = [
  ["street", "Street address"],
  ["city", "City"],
  ["country", "Country"],
  ["contactName", "Contact name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;

const addressField = z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH);

/**
 * A structured address and its receiving contact, as stored on records. Trims
 * text fields and defaults them to "" (email is validated, not trimmed;
 * addressName stays optional). Required fields and postal formats are left to
 * {@link addressIssues} so a draft can hold an incomplete address.
 *
 * @throws {z.ZodError} From `parse()` on an over-long field, a malformed email
 *   or phone, or over-long combined text.
 */
export const addressSchema = z
  .object({
    addressName: addressField.optional(),
    organization: addressField.default(""),
    street: z.string().trim().max(ADDRESS_STREET_MAX_LENGTH).default(""),
    street2: addressField.default(""),
    city: addressField.default(""),
    region: addressField.default(""),
    postalCode: addressField.default(""),
    country: addressField.default(""),
    contactName: addressField.default(""),
    email: z.union([z.literal(""), z.email()]).default(""),
    phone: addressField
      .refine(
        (value) => !value || isPlausiblePhoneNumber(value),
        `Enter a valid phone number of at least ${PHONE_MIN_DIGITS} digits.`,
      )
      .default(""),
    confirmed: z.boolean().default(false),
  })
  .refine(
    (address) =>
      Object.values(address)
        .filter((value) => typeof value === "string")
        .join("\n").length <= COMBINED_MAX_LENGTH,
    "Address and contact details are too long.",
  );

/** A parsed address. `confirmed` means a person reviewed it. */
export type Address = z.infer<typeof addressSchema>;

/**
 * Starts an address from what a record already holds, for the user to split
 * into fields.
 *
 * @param legacy - Legacy free-text address, kept whole as the street line.
 * @param contactName - Receiving contact already known, or "".
 * @param email - Contact email already known, or "".
 * @returns An unconfirmed address; other text fields "", no `addressName`.
 */
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

/**
 * Renders an address as the text kept in the legacy free-text fields.
 *
 * @param address - Address to render; it is not validated.
 * @returns Mailing-label lines, then "Contact:", "Email:" and "Phone:" lines,
 *   joined with "\n"; empty parts skipped ("" for a blank address).
 */
export function formatAddress(address: Address): string {
  return [
    address.organization,
    address.street,
    address.street2,
    [address.city, address.region, address.postalCode]
      .filter(Boolean)
      .join(", "),
    address.country,
    address.contactName && `Contact: ${address.contactName}`,
    address.email && `Email: ${address.email}`,
    address.phone && `Phone: ${address.phone}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Lists everything that stops an address being shipped to: missing required
 * fields, a missing state/province or postal code where the country uses one,
 * the US ZIP and Canadian postal formats, and every schema rule.
 *
 * @param address - Address to check, as typed or as stored. Postal formats are
 *   checked on the trimmed value.
 * @returns User-facing messages, each once: required fields (in form order),
 *   region, postal code, then schema messages. Empty if the address is usable.
 */
export function addressIssues(address: Address): string[] {
  const country = normalizeCountry(address.country);
  const issues = [
    ...listMissingFields(address),
    ...listRegionIssues(address, country),
    ...listPostalCodeIssues(address, country),
    ...listSchemaIssues(address),
  ];
  return [...new Set(issues)];
}

/**
 * Guards issuing a purchase order: the shipping address must be complete and
 * confirmed by a person.
 *
 * @param address - The purchase order's shipping address.
 * @throws {Rejection} "Shipping address: " followed by the
 *   {@link addressIssues} messages joined with spaces, when there are any;
 *   otherwise "Review and confirm the shipping address before issuing this
 *   PO." when it is unconfirmed.
 */
export function assertConfirmedAddress(address: Address): void {
  const issues = addressIssues(address);
  if (issues.length)
    throw new Rejection(`Shipping address: ${issues.join(" ")}`);
  if (!address.confirmed)
    throw new Rejection(
      "Review and confirm the shipping address before issuing this PO.",
    );
}

/**
 * Reads the address JSON that the address fields post in a hidden form input.
 *
 * @param data - Submitted form data.
 * @param name - Name of the hidden input.
 * @returns The parsed address, or undefined when the input is missing or empty.
 * @throws {SyntaxError} When the input does not hold JSON.
 * @throws {z.ZodError} When the JSON is not a valid address.
 */
export function addressFromForm(
  data: FormData,
  name = "addressDetails",
): Address | undefined {
  const value = data.get(name);
  return value ? addressSchema.parse(JSON.parse(String(value))) : undefined;
}

function isPlausiblePhoneNumber(value: string): boolean {
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= PHONE_MIN_DIGITS && PHONE_CHARACTERS.test(value);
}

function normalizeCountry(country: string): string {
  return country.trim().toUpperCase();
}

function listMissingFields(address: Address): string[] {
  return REQUIRED_FIELDS.filter(([key]) => !address[key].trim()).map(
    ([, label]) => `${label} is required.`,
  );
}

function listRegionIssues(address: Address, country: string): string[] {
  if (!REGION_REQUIRED_COUNTRY_NAMES.includes(country)) return [];
  return address.region.trim() ? [] : ["State / province is required."];
}

// Checked trimmed, as addressSchema will store it, so a stray space does not
// block confirming an address that would save cleanly.
function listPostalCodeIssues(address: Address, country: string): string[] {
  const issues: string[] = [];
  const postalCode = address.postalCode.trim();
  if (!NO_POSTAL_CODE_COUNTRY_NAMES.includes(country) && !postalCode)
    issues.push(
      "ZIP / postal code is required (enter N/A where no postal code is used).",
    );
  if (US_COUNTRY_NAMES.includes(country) && !US_ZIP_CODE.test(postalCode))
    issues.push("US ZIP code must be 5 digits or ZIP+4.");
  if (
    CANADA_COUNTRY_NAMES.includes(country) &&
    !CANADIAN_POSTAL_CODE.test(postalCode)
  )
    issues.push("Canadian postal code must use the format A1A 1A1.");
  return issues;
}

function listSchemaIssues(address: Address): string[] {
  const parsed = addressSchema.safeParse(address);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
}
